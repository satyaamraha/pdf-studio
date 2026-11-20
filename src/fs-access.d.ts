/**
 * File System Access API (Chrome, Edge, Opera). Not yet in TypeScript's DOM types.
 * Lets the web app save back to the file it opened instead of downloading a copy.
 */
interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showOpenFilePicker?(options?: { multiple?: boolean; types?: FilePickerType[]; excludeAcceptAllOption?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { suggestedName?: string; types?: FilePickerType[] }): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  launchQueue?: { setConsumer(consumer: (params: { files: readonly FileSystemFileHandle[] }) => void): void };
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}
