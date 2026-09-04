/* The shared domain package targets browsers too and references the DOM `BufferSource` alias; the hub compiles with the Node lib only. */
type BufferSource = ArrayBufferView | ArrayBuffer;
