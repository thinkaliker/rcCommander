export interface RcloneFile {
    Path: string;
    Name: string;
    Size: number;
    MimeType: string;
    ModTime: string;
    IsDir: boolean;
}

export interface CopyJob {
    id: string;
    /** 'upload' streams come from the browser and cannot be restarted. */
    kind?: 'copy' | 'upload';
    source: string;
    destination: string;
    progress: string;
    status: 'running' | 'completed' | 'error';
    error?: string;
    threads: number;
    autoRemoveSeconds?: number;
    elapsedTime?: string;
    speed?: string;
    eta?: string;
}
