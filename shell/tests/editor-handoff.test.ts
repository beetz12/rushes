import { describe, it, expect, vi, afterEach } from 'vitest';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as host from 'node:os';
import {
  editorArguments,
  expandEditorArguments,
  openInEditor,
  originalEditorValues,
} from '../src/main/editor-handoff';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await files.rm(root, { recursive: true, force: true });
});
async function rig() {
  const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-editor-'));
  roots.push(root);
  const initialFolder = paths.join(root, 'Take with spaces;$(literal)');
  await files.mkdir(initialFolder);
  const folder = await files.realpath(initialFolder);
  const tracks = await Promise.all(
    ['screen', 'camera', 'mic', 'system'].map(async (role) => {
      const path = paths.join(folder, role + '.mov');
      await files.writeFile(path, 'unchanged original ' + role);
      return { role, path, present: true };
    }),
  );
  const recording = {
    packagePath: folder,
    tracks,
    manifest: {
      tracks: tracks.map((track) => ({
        role: track.role,
        offsetMs: track.role === 'camera' ? 13 : 0,
      })),
    },
  };
  const exportPath = paths.join(root, 'Exported raw tracks');
  const actions = {
    storageRoot: root,
    show: vi.fn(async () => recording),
    exportTracks: vi.fn(async () => {
      await files.mkdir(exportPath);
      return { path: exportPath };
    }),
    reveal: vi.fn(),
    launch: vi.fn(async () => {}),
  };
  return { root, folder, recording, actions, exportPath };
}
describe('raw original editor handoff', () => {
  it('parses quotes/escapes first, then keeps substituted paths and shell-looking text in literal argv', async () => {
    const r = await rig();
    const template =
      '"/Applications/Editor Suite/editor" --screen="{screen}" --camera {camera} --offset-ms {cameraOffsetMs} "$(touch /tmp/example)" "" escaped\\ word';
    await expect(openInEditor('take', template, r.actions)).resolves.toEqual({ started: true });
    expect(r.actions.launch).toHaveBeenCalledExactlyOnceWith('/Applications/Editor Suite/editor', [
      '--screen=' + paths.join(r.folder, 'screen.mov'),
      '--camera',
      paths.join(r.folder, 'camera.mov'),
      '--offset-ms',
      '13',
      '$(touch /tmp/example)',
      '',
      'escaped word',
    ]);
    expect(r.actions.exportTracks).not.toHaveBeenCalled();
    expect(await files.readFile(paths.join(r.folder, 'screen.mov'), 'utf8')).toBe(
      'unchanged original screen',
    );
  });
  it('rejects unknown placeholders, missing inputs, malformed quotes and direct shell commands', async () => {
    for (const value of [
      'editor {unknown}',
      'editor {{screen}}',
      'editor "unfinished',
      'editor ending\\',
      '/bin/sh -c "editor {screen}"',
      '{screen}',
    ])
      expect(() => editorArguments(value)).toThrow();
    expect(() =>
      expandEditorArguments(editorArguments('editor {camera}'), { screen: '/screen.mov' }),
    ).toThrow('no camera value');
    const r = await rig();
    r.recording.tracks.find((track) => track.role === 'camera')!.present = false;
    await expect(openInEditor('take', 'editor {camera}', r.actions)).rejects.toMatchObject({
      code: 'editor-input-unavailable',
    });
    expect(r.actions.launch).not.toHaveBeenCalled();
  });
  it('validates original realpaths against the package and rejects a symlink outside the library', async () => {
    const r = await rig();
    const outside = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-editor-outside-'));
    roots.push(outside);
    const master = paths.join(outside, 'outside.mov');
    await files.writeFile(master, 'external file');
    const screen = r.recording.tracks.find((track) => track.role === 'screen')!;
    await files.unlink(screen.path);
    await files.symlink(master, screen.path);
    await expect(
      originalEditorValues(r.recording, r.root, editorArguments('editor {screen}')),
    ).rejects.toMatchObject({ code: 'editor-path-rejected' });
    expect(r.actions.launch).not.toHaveBeenCalled();
    r.recording.packagePath = outside;
    await expect(openInEditor('take', 'editor {package}', r.actions)).rejects.toMatchObject({
      code: 'editor-path-rejected',
    });
  });
  it('defaults to a raw-track export followed by Finder reveal, without starting an editor', async () => {
    const r = await rig();
    await expect(openInEditor('take', '', r.actions)).resolves.toEqual({
      revealed: true,
      path: r.exportPath,
    });
    expect(r.actions.exportTracks).toHaveBeenCalledExactlyOnceWith('take');
    expect(r.actions.reveal).toHaveBeenCalledExactlyOnceWith(r.exportPath);
    expect(r.actions.show).not.toHaveBeenCalled();
    expect(r.actions.launch).not.toHaveBeenCalled();
  });
  it('honors a cancelled export and propagates launch failure without reporting success', async () => {
    const r = await rig();
    r.actions.exportTracks.mockResolvedValueOnce({ canceled: true } as any);
    await expect(openInEditor('take', '', r.actions)).resolves.toEqual({ canceled: true });
    expect(r.actions.reveal).not.toHaveBeenCalled();
    r.actions.launch.mockRejectedValueOnce(new Error('Fixture editor unavailable'));
    await expect(openInEditor('take', "editor '{package}'", r.actions)).rejects.toThrow(
      'editor unavailable',
    );
  });
});
