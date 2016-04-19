import {Observable} from 'rx';
import {HTTPSource} from './HTTPSource';
import {StreamAdapter} from '@cycle/base';
import RxAdapter from '@cycle/rx-adapter';
import * as superagent from 'superagent';
import {RequestOptions, RequestInput, Response} from './interfaces';

function preprocessReqOptions(reqOptions: RequestOptions): RequestOptions {
  reqOptions.withCredentials = reqOptions.withCredentials || false;
  reqOptions.redirects = typeof reqOptions.redirects === 'number' ? reqOptions.redirects : 5;
  reqOptions.type = reqOptions.type || `json`;
  reqOptions.method = reqOptions.method || `get`;
  return reqOptions;
}

export function optionsToSuperagent(rawReqOptions: RequestOptions) {
  const reqOptions = preprocessReqOptions(rawReqOptions);
  if (typeof reqOptions.url !== `string`) {
    throw new Error(`Please provide a \`url\` property in the request options.`);
  }
  const lowerCaseMethod = reqOptions.method.toLowerCase();
  const sanitizedMethod = lowerCaseMethod === `delete` ? `del` : lowerCaseMethod;

  let request = superagent[sanitizedMethod](reqOptions.url);
  if (typeof request.redirects === `function`) {
    request = request.redirects(reqOptions.redirects);
  }
  request = request.type(reqOptions.type);
  if (reqOptions.send) {
    request = request.send(reqOptions.send);
  }
  if (reqOptions.accept) {
    request = request.accept(reqOptions.accept);
  }
  if (reqOptions.query) {
    request = request.query(reqOptions.query);
  }
  if (reqOptions.withCredentials) {
    request = request.withCredentials();
  }
  if (typeof reqOptions.user === 'string' && typeof reqOptions.password === 'string') {
    request = request.auth(reqOptions.user, reqOptions.password);
  }
  if (reqOptions.headers) {
    for (let key in reqOptions.headers) {
      if (reqOptions.headers.hasOwnProperty(key)) {
        request = request.set(key, reqOptions.headers[key]);
      }
    }
  }
  if (reqOptions.field) {
    for (let key in reqOptions.field) {
      if (reqOptions.field.hasOwnProperty(key)) {
        request = request.field(key, reqOptions.field[key]);
      }
    }
  }
  if (reqOptions.attach) {
    for (let i = reqOptions.attach.length - 1; i >= 0; i--) {
      const a = reqOptions.attach[i];
      request = request.attach(a.name, a.path, a.filename);
    }
  }
  return request;
}

export function createResponse$(reqInput: RequestInput) {
  return Observable.create(observer => {
    let request: any;
    try {
      const reqOptions = normalizeRequestInput(reqInput);
      request = optionsToSuperagent(reqOptions);
      if (reqOptions.progress) {
        request = request.on('progress', (res: Response) => {
          res.request = reqOptions;
          observer.onNext(res);
        });
      }
      request.end((err: any, res: Response) => {
        if (err) {
          observer.onError(err);
        } else {
          res.request = reqOptions;
          observer.onNext(res);
          observer.onCompleted();
        }
      });
    } catch (err) {
      observer.onError(err);
    }

    return function onDispose() {
      if (request) {
        request.abort();
      }
    };
  });
}

function softNormalizeRequestInput(reqInput: RequestInput): RequestOptions {
  let reqOptions: RequestOptions;
  try {
    reqOptions = normalizeRequestInput(reqInput);
  } catch (err) {
    reqOptions = {url: 'Error', _error: err};
  }
  return reqOptions;
}

function normalizeRequestInput(reqOptions: RequestInput): RequestOptions {
  if (typeof reqOptions === 'string') {
    return {url: <string> reqOptions};
  } else if (typeof reqOptions === 'object') {
    return <RequestOptions> reqOptions;
  } else {
    throw new Error(`Observable of requests given to HTTP Driver must emit ` +
      `either URL strings or objects with parameters.`);
  }
}

function makeRequestInputToResponse$(runStreamAdapter: StreamAdapter) {
  return function requestInputToResponse$(reqInput: RequestInput): any {
    let response$ = createResponse$(reqInput).replay(null, 1);
    response$.connect();
    response$ = (runStreamAdapter) ?
      runStreamAdapter.adapt(response$, RxAdapter.streamSubscribe) :
      response$;
    Object.defineProperty(response$, 'request', <PropertyDescriptor> {
      value: softNormalizeRequestInput(reqInput),
      writable: false,
    });
    return response$;
  };
}

/**
 * HTTP Driver factory.
 *
 * This is a function which, when called, returns a HTTP Driver for Cycle.js
 * apps. The driver is also a function, and it takes an Observable of requests
 * as input, and generates a metastream of responses.
 *
 * **Requests**. The Observable of requests should emit either strings or
 * objects. If the Observable emits strings, those should be the URL of the
 * remote resource over HTTP. If the Observable emits objects, these should be
 * instructions how superagent should execute the request. These objects follow
 * a structure similar to superagent's request API itself.
 * `request` object properties:
 *
 * - `url` *(String)*: the remote resource path. **required**
 * - `method` *(String)*: HTTP Method for the request (GET, POST, PUT, etc).
 * - `query` *(Object)*: an object with the payload for `GET` or `POST`.
 * - `send` *(Object)*: an object with the payload for `POST`.
 * - `headers` *(Object)*: object specifying HTTP headers.
 * - `accept` *(String)*: the Accept header.
 * - `type` *(String)*: a short-hand for setting Content-Type.
 * - `user` *(String)*: username for authentication.
 * - `password` *(String)*: password for authentication.
 * - `field` *(Object)*: object where key/values are Form fields.
 * - `progress` *(Boolean)*: whether or not to detect and emit progress events
 * on the response Observable.
 * - `attach` *(Array)*: array of objects, where each object specifies `name`,
 * `path`, and `filename` of a resource to upload.
 * - `withCredentials` *(Boolean)*: enables the ability to send cookies from the
 * origin.
 * - `redirects` *(Number)*: number of redirects to follow.
 *
 * **Responses**. A metastream is an Observable of Observables. The response
 * metastream emits Observables of responses. These Observables of responses
 * have a `request` field attached to them (to the Observable object itself)
 * indicating which request (from the driver input) generated this response
 * Observable. The response Observables themselves emit the response object
 * received through superagent.
 *
 * @return {Function} the HTTP Driver function
 * @function makeHTTPDriver
 */
export function makeHTTPDriver(): Function {
  function httpDriver(request$: Observable<RequestInput>, runSA: StreamAdapter): HTTPSource {
    let response$$ = request$
      .map(makeRequestInputToResponse$(runSA))
      .replay(null, 1);
    let httpSource = new HTTPSource(response$$, runSA, []);
    response$$.connect();
    return httpSource;
  }
  (<any> httpDriver).streamAdapter = RxAdapter;
  return httpDriver;
}
