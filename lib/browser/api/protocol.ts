import { ProtocolRequest, session } from 'electron/main';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { ReadableStream } from 'stream/web';

// Global protocol APIs.
const { registerSchemesAsPrivileged, getStandardSchemes, Protocol } = process._linkedBinding('electron_browser_protocol');

const ERR_FAILED = -2;
const ERR_UNEXPECTED = -9;

const isBuiltInScheme = (scheme: string) => scheme === 'http' || scheme === 'https';

function makeStreamFromPipe (pipe: any): ReadableStream {
  const buf = new Uint8Array(1024 * 1024 /* 1 MB */);
  return new ReadableStream({
    async pull (controller) {
      try {
        const rv = await pipe.read(buf);
        if (rv > 0) {
          controller.enqueue(buf.subarray(0, rv));
        } else {
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      }
    }
  });
}

function convertToRequestBody (uploadData: ProtocolRequest['uploadData']): RequestInit['body'] {
  if (!uploadData) return null;
  // Optimization: skip creating a stream if the request is just a single buffer.
  if (uploadData.length === 1 && (uploadData[0] as any).type === 'rawData') return uploadData[0].bytes;

  const chunks = [...uploadData] as any[]; // TODO: types are wrong
  let current: ReadableStreamDefaultReader | null = null;
  return new ReadableStream({
    pull (controller) {
      if (current) {
        current.read().then(({ done, value }) => {
          controller.enqueue(value);
          if (done) current = null;
        }, (err) => {
          controller.error(err);
        });
      } else {
        if (!chunks.length) { return controller.close(); }
        const chunk = chunks.shift()!;
        if (chunk.type === 'rawData') { controller.enqueue(chunk.bytes); } else if (chunk.type === 'file') {
          current = Readable.toWeb(createReadStream(chunk.filePath, { start: chunk.offset ?? 0, end: chunk.length >= 0 ? chunk.offset + chunk.length : undefined })).getReader();
          this.pull!(controller);
        } else if (chunk.type === 'stream') {
          current = makeStreamFromPipe(chunk.body).getReader();
          this.pull!(controller);
        }
      }
    }
  }) as RequestInit['body'];
}

// TODO(codebytere): Use Object.hasOwn() once we update to ECMAScript 2022.
function validateResponse (res: Response) {
  if (!res || typeof res !== 'object') return false;

  if (res.type === 'error') return true;

  const exists = (key: string) => Object.hasOwn(res, key);

  if (exists('status') && typeof res.status !== 'number') return false;
  if (exists('statusText') && typeof res.statusText !== 'string') return false;
  if (exists('headers') && typeof res.headers !== 'object') return false;

  if (exists('body')) {
    if (typeof res.body !== 'object') return false;
    if (res.body !== null && !(res.body instanceof ReadableStream)) return false;
  }

  return true;
}

Protocol.prototype.handle = function (this: Electron.Protocol, scheme: string, handler: (req: Request) => Response | Promise<Response>) {
  const register = isBuiltInScheme(scheme) ? this.interceptProtocol : this.registerProtocol;
  const success = register.call(this, scheme, async (preq: ProtocolRequest, cb: any) => {
    try {
      const body = convertToRequestBody(preq.uploadData);
      const req = new Request(preq.url, {
        headers: preq.headers,
        method: preq.method,
        referrer: preq.referrer,
        body,
        duplex: body instanceof ReadableStream ? 'half' : undefined
      } as any);
      const res = await handler(req);
      if (!validateResponse(res)) {
        return cb({ error: ERR_UNEXPECTED });
      } else if (res.type === 'error') {
        cb({ error: ERR_FAILED });
      } else {
        cb({
          data: res.body ? Readable.fromWeb(res.body as ReadableStream<ArrayBufferView>) : null,
          headers: res.headers ? Object.fromEntries(res.headers) : {},
          statusCode: res.status,
          statusText: res.statusText,
          mimeType: (res as any).__original_resp?._responseHead?.mimeType
        });
      }
    } catch (e) {
      console.error(e);
      cb({ error: ERR_UNEXPECTED });
    }
  });
  if (!success) throw new Error(`Failed to register protocol: ${scheme}`);
};

Protocol.prototype.unhandle = function (this: Electron.Protocol, scheme: string) {
  const unregister = isBuiltInScheme(scheme) ? this.uninterceptProtocol : this.unregisterProtocol;
  if (!unregister.call(this, scheme)) { throw new Error(`Failed to unhandle protocol: ${scheme}`); }
};

Protocol.prototype.isProtocolHandled = function (this: Electron.Protocol, scheme: string) {
  const isRegistered = isBuiltInScheme(scheme) ? this.isProtocolIntercepted : this.isProtocolRegistered;
  return isRegistered.call(this, scheme);
};

const protocol = {
  registerSchemesAsPrivileged,
  getStandardSchemes,
  registerStringProtocol: (...args) => session.defaultSession.protocol.registerStringProtocol(...args),
  registerBufferProtocol: (...args) => session.defaultSession.protocol.registerBufferProtocol(...args),
  registerStreamProtocol: (...args) => session.defaultSession.protocol.registerStreamProtocol(...args),
  registerFileProtocol: (...args) => session.defaultSession.protocol.registerFileProtocol(...args),
  registerHttpProtocol: (...args) => session.defaultSession.protocol.registerHttpProtocol(...args),
  registerProtocol: (...args) => session.defaultSession.protocol.registerProtocol(...args),
  unregisterProtocol: (...args) => session.defaultSession.protocol.unregisterProtocol(...args),
  isProtocolRegistered: (...args) => session.defaultSession.protocol.isProtocolRegistered(...args),
  interceptStringProtocol: (...args) => session.defaultSession.protocol.interceptStringProtocol(...args),
  interceptBufferProtocol: (...args) => session.defaultSession.protocol.interceptBufferProtocol(...args),
  interceptStreamProtocol: (...args) => session.defaultSession.protocol.interceptStreamProtocol(...args),
  interceptFileProtocol: (...args) => session.defaultSession.protocol.interceptFileProtocol(...args),
  interceptHttpProtocol: (...args) => session.defaultSession.protocol.interceptHttpProtocol(...args),
  interceptProtocol: (...args) => session.defaultSession.protocol.interceptProtocol(...args),
  uninterceptProtocol: (...args) => session.defaultSession.protocol.uninterceptProtocol(...args),
  isProtocolIntercepted: (...args) => session.defaultSession.protocol.isProtocolIntercepted(...args),
  handle: (...args) => session.defaultSession.protocol.handle(...args),
  unhandle: (...args) => session.defaultSession.protocol.unhandle(...args),
  isProtocolHandled: (...args) => session.defaultSession.protocol.isProtocolHandled(...args)
} as typeof Electron.protocol;

export default protocol;
