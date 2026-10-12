import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, extname, basename } from 'node:path';
import { z } from 'zod';

const placeholders = ['screen', 'camera', 'mic', 'system', 'package', 'cameraOffsetMs'] as const;
type Placeholder = (typeof placeholders)[number];
type EditorValues = Partial<Record<Placeholder, string>>;
function invalid(message: string, code = 'editor-template-invalid') {
  return Object.assign(new Error(message), { code });
}
// Only quotes and escaping group words. No shell syntax is evaluated or expanded.
export function editorArguments(template: string): string[] {
  const tokens: string[] = [];
  let word = '',
    started = false,
    quote: "'" | '"' | undefined;
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char === '\\' && quote !== "'") {
      if (index + 1 === template.length)
        throw invalid('The editor command ends with an incomplete escape.');
      word += template[++index];
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw invalid('The editor command has an unclosed quote.');
  if (started) tokens.push(word);
  if (!tokens.length || !tokens[0]) throw invalid('Choose an editor executable.');
  if (tokens[0].includes('{') || tokens[0].includes('}'))
    throw invalid('Use a fixed editor executable; placeholders belong in its arguments.');
  if (
    [
      'sh',
      'bash',
      'zsh',
      'fish',
      'ksh',
      'csh',
      'tcsh',
      'dash',
      'cmd',
      'powershell',
      'pwsh',
    ].includes(basename(tokens[0]).toLowerCase())
  )
    throw invalid('Choose an editor executable directly instead of a shell.');
  for (const token of tokens) {
    const remaining = token.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
      if (!placeholders.includes(key as Placeholder))
        throw invalid(`Unknown editor placeholder: {${key}}`);
      return '';
    });
    if (remaining.includes('{') || remaining.includes('}'))
      throw invalid('Editor placeholders must use one pair of braces.');
  }
  return tokens;
}
export function expandEditorArguments(tokens: string[], values: EditorValues) {
  const args = tokens.slice(1).map((token) =>
    token.replace(/\{([^{}]+)\}/g, (_match, key: Placeholder) => {
      const value = values[key];
      if (value === undefined)
        throw invalid(
          `This recording has no ${key} value for the editor command.`,
          'editor-input-unavailable',
        );
      return value;
    }),
  );
  return { executable: tokens[0], args };
}
function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}
const showSchema = z.object({
  packagePath: z.string(),
  tracks: z.array(z.object({ role: z.string(), path: z.string(), present: z.boolean() })),
  manifest: z.object({
    tracks: z.array(z.object({ role: z.string(), offsetMs: z.number().int().optional() })),
  }),
});
export async function originalEditorValues(
  raw: unknown,
  storageRoot: string,
  tokens: string[],
): Promise<EditorValues> {
  const show = showSchema.parse(raw),
    root = await realpath(storageRoot),
    folder = await realpath(show.packagePath);
  if (!within(root, folder) || !(await stat(folder)).isDirectory())
    throw invalid('The recording package is outside the library.', 'editor-path-rejected');
  const values: EditorValues = { package: folder };
  const requested = new Set(
    tokens.flatMap((token) => Array.from(token.matchAll(/\{([^{}]+)\}/g), (match) => match[1])),
  );
  if (requested.has('cameraOffsetMs')) {
    requested.add('screen');
    requested.add('camera');
  }
  for (const role of ['screen', 'camera', 'mic', 'system'] as const) {
    if (!requested.has(role)) continue;
    const track = show.tracks.find((item) => item.role === role && item.present);
    if (!track) throw invalid(`This recording has no ${role} track.`, 'editor-input-unavailable');
    const path = await realpath(track.path);
    if (
      !within(folder, path) ||
      !(await stat(path)).isFile() ||
      !['.mov', '.mp4', '.m4a', '.wav'].includes(extname(path).toLowerCase())
    )
      throw invalid(
        `The ${role} track is not a valid original inside the package.`,
        'editor-path-rejected',
      );
    values[role] = path;
  }
  if (requested.has('cameraOffsetMs')) {
    const screen = show.manifest.tracks.find((item) => item.role === 'screen')?.offsetMs;
    const camera = show.manifest.tracks.find((item) => item.role === 'camera')?.offsetMs;
    if (screen === undefined || camera === undefined)
      throw invalid(
        'The original camera/screen offset is unavailable.',
        'editor-input-unavailable',
      );
    values.cameraOffsetMs = String(camera - screen);
  }
  return values;
}
export async function openInEditor(
  id: string,
  template: string,
  actions: {
    show(id: string): Promise<unknown>;
    storageRoot: string;
    exportTracks(id: string): Promise<{ canceled?: boolean; path?: string }>;
    reveal(path: string): void;
    launch(executable: string, args: string[]): Promise<void>;
  },
) {
  if (!template.trim()) {
    const result = await actions.exportTracks(id);
    if (result.canceled) return { canceled: true };
    if (!result.path || !(await stat(result.path)).isDirectory())
      throw invalid('The raw track export folder is unavailable.', 'editor-input-unavailable');
    actions.reveal(result.path);
    return { revealed: true, path: result.path };
  }
  const tokens = editorArguments(template);
  const values = await originalEditorValues(await actions.show(id), actions.storageRoot, tokens);
  const command = expandEditorArguments(tokens, values);
  await actions.launch(command.executable, command.args);
  return { started: true };
}
