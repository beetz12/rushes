// What Settings shows for launch at login, as read back from the OS.
export interface LoginItemState {
  /// Whether the OS will open Rushes at login.
  enabled: boolean;
  /// False for development builds, which must not register the Electron binary.
  supported: boolean;
  /// macOS is waiting for the user to allow the item in System Settings.
  requiresApproval: boolean;
}
