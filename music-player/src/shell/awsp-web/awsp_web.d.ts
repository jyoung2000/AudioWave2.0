/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

/**
 * An audio stream after its header: the range's bytes, in chunks of up to 64 KiB.
 */
export class AwspAudio {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stop the stream (`STOP_SENDING`, code 0): a seek or a cancelled request (§3.2).
     */
    cancel(): Promise<any>;
    /**
     * The next chunk as a `Uint8Array`, or `null` when the server finished the range.
     */
    read(): Promise<any>;
    readonly codec: number;
    readonly tier: number;
    /**
     * The whole file's length in bytes (§3.2 `total_len`).
     */
    readonly total_len: number;
}

/**
 * The client's iroh endpoint and its identity.
 */
export class AwspClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(): Promise<any>;
    /**
     * Connect to the ticket's endpoint with ALPN `awsp/1`. Resolves an `AwspConnection`.
     */
    connect(ticket: string, relay_override?: string | null): Promise<any>;
    /**
     * Bind an endpoint. `secret` is the stored 32-byte key, or empty for a new identity; `relays`
     * are the home relays (the ticket's, or an override).
     */
    static create(secret: Uint8Array, relays: string[]): Promise<AwspClient>;
    endpoint_id(): string;
    secret_key(): Uint8Array;
}

/**
 * One QUIC connection to the server: one control stream, one stream per audio fetch (§3).
 */
export class AwspConnection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(code: number, reason: string): void;
    /**
     * Resolves `{"code": <application code or null>, "reason": "…"}` when the connection ends.
     */
    closed(): Promise<any>;
    /**
     * `relay` or `direct`, from the selected path (a browser's is always the relay).
     */
    connection_type(): string;
    /**
     * One audio fetch (§3.2): the request frame, then the 16-byte header. Resolves an `AwspAudio`
     * positioned at the first byte of the range, or rejects with `awsp-reset:<code>`.
     */
    fetch(track_id: string, byte_start: number, byte_end: number | null | undefined, tier: string): Promise<any>;
    /**
     * Open the control stream. Resolves an `AwspControl`.
     */
    open_control(): Promise<any>;
    remote_id(): string;
    rtt_ms(): number;
}

/**
 * The control stream: length-prefixed JSON frames both ways (§3.1).
 */
export class AwspControl {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Finish the send side (a clean goodbye).
     */
    finish(): Promise<any>;
    /**
     * The next frame's JSON text, or `null` at a clean end of the stream.
     */
    recv(): Promise<any>;
    /**
     * Send one frame (the JSON text of `{id, type, seq, payload}`).
     */
    send(json: string): Promise<any>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;

/**
 * `{"endpoint_id": "…", "relay_urls": ["…"]}` for a ticket, so the worker can pick the home relay
 * before it binds the endpoint.
 */
export function ticket_info(ticket: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_awspaudio_free: (a: number, b: number) => void;
    readonly __wbg_awspclient_free: (a: number, b: number) => void;
    readonly __wbg_awspconnection_free: (a: number, b: number) => void;
    readonly __wbg_awspcontrol_free: (a: number, b: number) => void;
    readonly awspaudio_cancel: (a: number) => number;
    readonly awspaudio_codec: (a: number) => number;
    readonly awspaudio_read: (a: number) => number;
    readonly awspaudio_tier: (a: number) => number;
    readonly awspaudio_total_len: (a: number) => number;
    readonly awspclient_close: (a: number) => number;
    readonly awspclient_connect: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly awspclient_create: (a: number, b: number, c: number, d: number) => number;
    readonly awspclient_endpoint_id: (a: number, b: number) => void;
    readonly awspclient_secret_key: (a: number, b: number) => void;
    readonly awspconnection_close: (a: number, b: number, c: number, d: number) => void;
    readonly awspconnection_closed: (a: number) => number;
    readonly awspconnection_connection_type: (a: number, b: number) => void;
    readonly awspconnection_fetch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly awspconnection_open_control: (a: number) => number;
    readonly awspconnection_remote_id: (a: number, b: number) => void;
    readonly awspconnection_rtt_ms: (a: number) => number;
    readonly awspcontrol_finish: (a: number) => number;
    readonly awspcontrol_recv: (a: number) => number;
    readonly awspcontrol_send: (a: number, b: number, c: number) => number;
    readonly start: () => void;
    readonly ticket_info: (a: number, b: number, c: number) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly __wasm_bindgen_func_elem_4184: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_4244: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3470: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3470_2: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_3470_3: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_1775: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_5358: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
