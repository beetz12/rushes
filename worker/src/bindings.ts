export interface Statement {
    bind(...values: unknown[]): Statement;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{
        results: T[];
    }>;
    run(): Promise<{
        success: boolean;
        meta: {
            changes?: number;
        };
    }>;
}
export interface Database {
    prepare(query: string): Statement;
    batch(statements: Statement[]): Promise<unknown>;
}
export interface StoredObject {
    key: string;
    size: number;
    etag: string;
    httpEtag: string;
    body: ReadableStream<Uint8Array>;
    httpMetadata?: {
        contentType?: string;
        cacheControl?: string;
    };
    range?: {
        offset: number;
        length: number;
    };
    writeHttpMetadata(headers: Headers): void;
}
export interface Multipart {
    uploadId: string;
    uploadPart(partNumber: number, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{
        partNumber: number;
        etag: string;
    }>;
    complete(parts: Array<{
        partNumber: number;
        etag: string;
    }>): Promise<StoredObject>;
    abort(): Promise<void>;
}
export interface Bucket {
    put(key: string, value: string | Uint8Array | ReadableStream<Uint8Array>, options?: {
        httpMetadata?: {
            contentType?: string;
            cacheControl?: string;
        };
    }): Promise<StoredObject>;
    get(key: string, options?: {
        range?: {
            offset: number;
            length: number;
        };
    }): Promise<StoredObject | null>;
    head(key: string): Promise<StoredObject | null>;
    delete(keys: string | string[]): Promise<void>;
    list(options: {
        prefix: string;
        cursor?: string;
    }): Promise<{
        objects: Array<{
            key: string;
        }>;
        truncated: boolean;
        cursor?: string;
    }>;
    createMultipartUpload(key: string, options?: {
        httpMetadata?: {
            contentType?: string;
            cacheControl?: string;
        };
    }): Promise<Multipart>;
    resumeMultipartUpload(key: string, uploadId: string): Multipart;
}
export interface Env {
    MEDIA: Bucket;
    DB: Database;
    OWNER_TOKEN: string;
    SESSION_SECRET: string;
    PUBLIC_BASE_URL: string;
    ALLOWED_ORIGINS?: string;
    MAX_UPLOAD_BYTES?: string;
}
