/** Things that both the main and renderer processes refer to */

export const statReportProtocol = 'yf-stat-report';

export interface StatReportHtmlPage {
  /** last part of the file name (e.g. "standings.html") */
  fileName: string;
  contents: string;
}

export interface SqbsExportFile {
  /** suffix to add to the user-selected file path, if exporting multiple files */
  fileSuffix?: string;
  contents: string;
}

/** Actions initiated by the Main process that involve switching away from the current file */
export enum FileSwitchActions {
  NewFile,
  OpenYftFile,
  CloseApp,
  ImportQbjTournament,
}

export const FileSwitchActionNames = {
  [FileSwitchActions.NewFile]: 'New File',
  [FileSwitchActions.OpenYftFile]: 'Open File',
  [FileSwitchActions.CloseApp]: 'Exit YellowFruit',
};

export interface IYftBackupFile {
  filePath: string;
  /** When the backup was last saved - stringify to ISO 8601 format */
  savedAtTime: Date;
  fileContents: object;
}

export interface IMatchImportFileRequest {
  filePath: string;
  fileContents: string;
}

/**
 * A random opaque identifier, safe to use as a QBJ `id` and as a file name.
 *
 * Uses `getRandomValues` rather than `randomUUID` on purpose: the latter is only exposed in a
 * secure context, and the renderer runs from `file://` in a packaged build. `getRandomValues` has
 * no such restriction. The `Math.random` branch exists so that a stripped-down test environment
 * without WebCrypto still produces an id instead of throwing - these ids are identifiers, never
 * credentials, so unpredictability is not a security property here.
 */
export function makeOpaqueId(prefix: string, byteLength: number = 12): string {
  const bytes = new Uint8Array(byteLength);
  // `globalThis` because this module is imported by both processes, and neither `window` nor node's
  // `global` exists in both. The lint environment here predates it being a declared global.
  // eslint-disable-next-line no-undef
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${prefix}${hex}`;
}
