(function (global) {
    'use strict';

    var AispAgent = {};
    AispAgent.version = '0.1.0';

    function nowMs() {
        if (global.performance && typeof global.performance.now === 'function') {
            return global.performance.now();
        }
        return Date.now();
    }

    function safeJsonStringify(value) {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return '"[unserializable]"';
        }
    }

    function createDeferred() {
        var resolve;
        var reject;
        var promise = new Promise(function (res, rej) {
            resolve = res;
            reject = rej;
        });
        return { promise: promise, resolve: resolve, reject: reject };
    }

    function createId(prefix) {
        var rand = Math.floor(Math.random() * 1e9);
        return (prefix || 'req') + '-' + Date.now() + '-' + rand;
    }

    function normalizeBaseUrl(url) {
        if (!url) return '';
        return String(url).replace(/\/+$/, '');
    }

    function joinUrl(baseUrl, path) {
        var b = normalizeBaseUrl(baseUrl);
        var p = String(path || '');
        if (!p) return b;
        if (p.charAt(0) !== '/') p = '/' + p;
        return b + p;
    }

    function Logger(options) {
        options = options || {};
        this.level = options.level || 'info';
        this.bufferSize = typeof options.bufferSize === 'number' ? options.bufferSize : 200;
        this.sink = typeof options.sink === 'function' ? options.sink : null;
        this.entries = [];
        this.listeners = [];
    }

    Logger.levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

    Logger.prototype._shouldLog = function (level) {
        var current = Logger.levels[this.level] || Logger.levels.info;
        var wanted = Logger.levels[level] || Logger.levels.info;
        return wanted >= current && wanted < Logger.levels.silent;
    };

    Logger.prototype._push = function (entry) {
        this.entries.push(entry);
        if (this.entries.length > this.bufferSize) this.entries.shift();
        for (var i = 0; i < this.listeners.length; i++) {
            try {
                this.listeners[i](entry);
            } catch (e) {}
        }
        if (this.sink) {
            try {
                this.sink(entry);
            } catch (e) {}
        }
    };

    Logger.prototype.onEntry = function (listener) {
        if (typeof listener !== 'function') return function () {};
        this.listeners.push(listener);
        var self = this;
        return function () {
            var idx = self.listeners.indexOf(listener);
            if (idx >= 0) self.listeners.splice(idx, 1);
        };
    };

    Logger.prototype.getEntries = function () {
        return this.entries.slice();
    };

    Logger.prototype._log = function (level, message, data) {
        if (!this._shouldLog(level)) return;
        var entry = {
            ts: Date.now(),
            level: level,
            message: String(message || ''),
            data: typeof data === 'undefined' ? null : data
        };
        this._push(entry);
        if (global.console && typeof global.console[level] === 'function') {
            try {
                global.console[level](entry.message, entry.data);
            } catch (e) {}
        } else if (global.console && typeof global.console.log === 'function') {
            try {
                global.console.log('[' + level + ']', entry.message, entry.data);
            } catch (e) {}
        }
    };

    Logger.prototype.debug = function (message, data) { this._log('debug', message, data); };
    Logger.prototype.info = function (message, data) { this._log('info', message, data); };
    Logger.prototype.warn = function (message, data) { this._log('warn', message, data); };
    Logger.prototype.error = function (message, data) { this._log('error', message, data); };

    function HttpError(message, status, body) {
        var err = new Error(message);
        err.name = 'HttpError';
        err.status = status;
        err.body = body;
        return err;
    }

    function TimeoutError(message) {
        var err = new Error(message);
        err.name = 'TimeoutError';
        return err;
    }

    function RestTransport(options) {
        options = options || {};
        this.baseUrl = normalizeBaseUrl(options.baseUrl || '');
        this.defaultHeaders = options.headers || {};
        this.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 15000;
        this.logger = options.logger || new Logger({ level: 'warn' });
        this.fetchImpl = options.fetchImpl || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
        this.xhrImpl = options.xhrImpl || null;
    }

    RestTransport.prototype.request = function (method, path, body, headers, timeoutMs) {
        method = String(method || 'GET').toUpperCase();
        var url = joinUrl(this.baseUrl, path);
        var allHeaders = {};
        var k;
        for (k in this.defaultHeaders) allHeaders[k] = this.defaultHeaders[k];
        for (k in (headers || {})) allHeaders[k] = headers[k];

        var hasBody = typeof body !== 'undefined' && body !== null;
        var payload = null;
        if (hasBody) {
            if (!allHeaders['Content-Type'] && !allHeaders['content-type']) {
                allHeaders['Content-Type'] = 'application/json';
            }
            payload = typeof body === 'string' ? body : safeJsonStringify(body);
        }

        var t0 = nowMs();
        this.logger.debug('AispAgent REST request', { method: method, url: url });

        var effectiveTimeout = typeof timeoutMs === 'number' ? timeoutMs : this.timeoutMs;

        if (this.fetchImpl) {
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = null;
            if (controller) {
                timer = setTimeout(function () {
                    try { controller.abort(); } catch (e) {}
                }, effectiveTimeout);
            }

            var opts = { method: method, headers: allHeaders };
            if (hasBody) opts.body = payload;
            if (controller) opts.signal = controller.signal;

            var self = this;
            return this.fetchImpl(url, opts).then(function (res) {
                if (timer) clearTimeout(timer);
                var elapsed = Math.round(nowMs() - t0);
                var contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
                var parseJson = contentType.indexOf('application/json') >= 0;
                return (parseJson ? res.json() : res.text()).then(function (data) {
                    self.logger.debug('AispAgent REST response', { method: method, url: url, status: res.status, ms: elapsed });
                    if (!res.ok) throw HttpError('HTTP ' + res.status + ' for ' + url, res.status, data);
                    return data;
                });
            }).catch(function (e) {
                if (timer) clearTimeout(timer);
                if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                    throw TimeoutError('Request timeout after ' + effectiveTimeout + 'ms: ' + url);
                }
                throw e;
            });
        }

        return this._xhrRequest(method, url, payload, allHeaders, effectiveTimeout, t0);
    };

    RestTransport.prototype._xhrRequest = function (method, url, payload, headers, timeoutMs, t0) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var XhrCtor = self.xhrImpl || global.XMLHttpRequest;
            if (!XhrCtor) {
                reject(new Error('No fetch/XMLHttpRequest available'));
                return;
            }
            var xhr = new XhrCtor();
            xhr.open(method, url, true);
            xhr.timeout = timeoutMs;
            var k;
            for (k in (headers || {})) {
                try { xhr.setRequestHeader(k, headers[k]); } catch (e) {}
            }
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                var elapsed = Math.round(nowMs() - t0);
                var contentType = xhr.getResponseHeader ? (xhr.getResponseHeader('content-type') || '') : '';
                var text = xhr.responseText;
                var data = text;
                if (contentType.indexOf('application/json') >= 0) {
                    try { data = JSON.parse(text); } catch (e) {}
                }
                self.logger.debug('AispAgent REST response', { method: method, url: url, status: xhr.status, ms: elapsed });
                if (xhr.status >= 200 && xhr.status < 300) resolve(data);
                else reject(HttpError('HTTP ' + xhr.status + ' for ' + url, xhr.status, data));
            };
            xhr.ontimeout = function () {
                reject(TimeoutError('Request timeout after ' + timeoutMs + 'ms: ' + url));
            };
            xhr.onerror = function () {
                reject(new Error('Network error: ' + url));
            };
            try {
                xhr.send(payload);
            } catch (e) {
                reject(e);
            }
        });
    };

    function Emitter() {
        this._listeners = {};
    }

    Emitter.prototype.on = function (event, handler) {
        if (typeof handler !== 'function') return function () {};
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
        var self = this;
        return function () {
            var list = self._listeners[event] || [];
            var idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
        };
    };

    Emitter.prototype.emit = function (event, payload) {
        var list = this._listeners[event] || [];
        for (var i = 0; i < list.length; i++) {
            try { list[i](payload); } catch (e) {}
        }
    };

    function WsTransport(options) {
        options = options || {};
        this.url = String(options.url || '');
        this.protocols = options.protocols || undefined;
        this.logger = options.logger || new Logger({ level: 'warn' });
        this.reconnect = options.reconnect !== false;
        this.minDelayMs = typeof options.minDelayMs === 'number' ? options.minDelayMs : 500;
        this.maxDelayMs = typeof options.maxDelayMs === 'number' ? options.maxDelayMs : 8000;
        this.requestTimeoutMs = typeof options.requestTimeoutMs === 'number' ? options.requestTimeoutMs : 15000;
        this.WebSocketImpl = options.WebSocketImpl || global.WebSocket;
        this.socket = null;
        this.emitter = new Emitter();
        this.pending = {};
        this._closing = false;
        this._attempt = 0;
        this._connectPromise = null;
    }

    WsTransport.prototype.on = function (event, handler) {
        return this.emitter.on(event, handler);
    };

    WsTransport.prototype._backoffDelay = function () {
        var base = Math.min(this.maxDelayMs, this.minDelayMs * Math.pow(2, this._attempt));
        var jitter = Math.floor(Math.random() * Math.min(500, base));
        return base + jitter;
    };

    WsTransport.prototype.connect = function () {
        if (this._connectPromise) return this._connectPromise;
        var self = this;
        this._closing = false;
        this._connectPromise = new Promise(function (resolve, reject) {
            if (!self.WebSocketImpl) {
                reject(new Error('WebSocket not available'));
                self._connectPromise = null;
                return;
            }
            try {
                self.socket = self.protocols ? new self.WebSocketImpl(self.url, self.protocols) : new self.WebSocketImpl(self.url);
            } catch (e) {
                reject(e);
                self._connectPromise = null;
                return;
            }
            self.socket.onopen = function () {
                self.logger.info('AispAgent WebSocket connected', { url: self.url });
                self._attempt = 0;
                self.emitter.emit('open', { url: self.url });
                resolve();
            };
            self.socket.onclose = function (evt) {
                self.logger.warn('AispAgent WebSocket closed', { code: evt && evt.code, reason: evt && evt.reason });
                self.emitter.emit('close', evt || {});
                self._connectPromise = null;
                if (!self._closing && self.reconnect) {
                    var delay = self._backoffDelay();
                    self._attempt++;
                    setTimeout(function () {
                        self.connect().catch(function () {});
                    }, delay);
                }
            };
            self.socket.onerror = function (evt) {
                self.emitter.emit('error', evt || {});
            };
            self.socket.onmessage = function (evt) {
                self._handleMessage(evt && evt.data);
            };
        });
        return this._connectPromise;
    };

    WsTransport.prototype.close = function () {
        this._closing = true;
        if (this.socket) {
            try { this.socket.close(); } catch (e) {}
        }
        this.socket = null;
        this._connectPromise = null;
        var k;
        for (k in this.pending) {
            if (this.pending[k] && this.pending[k].reject) {
                try { this.pending[k].reject(new Error('WebSocket closed')); } catch (e) {}
            }
        }
        this.pending = {};
    };

    WsTransport.prototype._handleMessage = function (raw) {
        var msg = raw;
        if (typeof raw === 'string') {
            try { msg = JSON.parse(raw); } catch (e) { msg = { type: 'event', raw: raw }; }
        }
        this.emitter.emit('message', msg);
        if (msg && msg.type === 'response' && msg.id && this.pending[msg.id]) {
            var entry = this.pending[msg.id];
            delete this.pending[msg.id];
            if (entry.timer) clearTimeout(entry.timer);
            if (msg.error) entry.reject(msg.error);
            else entry.resolve(msg.payload);
        } else if (msg && msg.type === 'event') {
            this.emitter.emit('event', msg);
        }
    };

    WsTransport.prototype.send = function (msg) {
        if (!this.socket || this.socket.readyState !== 1) {
            throw new Error('WebSocket not connected');
        }
        var text = typeof msg === 'string' ? msg : safeJsonStringify(msg);
        this.socket.send(text);
    };

    WsTransport.prototype.request = function (action, payload, timeoutMs) {
        var id = createId('ws');
        var deferred = createDeferred();
        var effectiveTimeout = typeof timeoutMs === 'number' ? timeoutMs : this.requestTimeoutMs;
        var self = this;
        var timer = setTimeout(function () {
            if (self.pending[id]) {
                delete self.pending[id];
                deferred.reject(TimeoutError('WebSocket request timeout after ' + effectiveTimeout + 'ms: ' + action));
            }
        }, effectiveTimeout);
        this.pending[id] = { resolve: deferred.resolve, reject: deferred.reject, timer: timer };
        this.send({ id: id, type: 'request', action: action, payload: payload || {} });
        return deferred.promise;
    };

    function ScientificToolRestAdapter(options) {
        options = options || {};
        this.name = options.name;
        this.path = options.path;
    }

    ScientificToolRestAdapter.prototype.list = function (client) {
        return client.rest.request('GET', this.path + '/tools');
    };

    ScientificToolRestAdapter.prototype.execute = function (client, payload) {
        return client.rest.request('POST', this.path + '/execute', payload || {});
    };

    function AispAgentClient(options) {
        options = options || {};
        this.logger = options.logger || new Logger({ level: 'info' });
        this.rest = new RestTransport({
            baseUrl: options.restBaseUrl || '',
            headers: options.headers || {},
            timeoutMs: options.timeoutMs,
            logger: this.logger,
            fetchImpl: options.fetchImpl,
            xhrImpl: options.xhrImpl
        });
        this.ws = options.wsUrl
            ? new WsTransport({
                url: options.wsUrl,
                protocols: options.wsProtocols,
                logger: this.logger,
                reconnect: options.wsReconnect,
                minDelayMs: options.wsMinDelayMs,
                maxDelayMs: options.wsMaxDelayMs,
                requestTimeoutMs: options.wsRequestTimeoutMs,
                WebSocketImpl: options.WebSocketImpl
            })
            : null;
        this.toolAdapters = {};
        this.protocols = {};

        this.registerToolAdapter('python', new ScientificToolRestAdapter({ name: 'python', path: '/tools/python' }));
        this.registerToolAdapter('matlab', new ScientificToolRestAdapter({ name: 'matlab', path: '/tools/matlab' }));
        this.registerToolAdapter('r', new ScientificToolRestAdapter({ name: 'r', path: '/tools/r' }));

        this.registerProtocol('autogpt', {
            name: 'autogpt',
            buildTask: function (goal, context) { return { goal: goal, context: context || {} }; }
        });
        this.registerProtocol('babyagi', {
            name: 'babyagi',
            buildTask: function (goal, context) { return { objective: goal, context: context || {} }; }
        });
    }

    AispAgentClient.prototype.registerToolAdapter = function (name, adapter) {
        if (!name || !adapter) return;
        this.toolAdapters[String(name).toLowerCase()] = adapter;
    };

    AispAgentClient.prototype.registerProtocol = function (name, protocol) {
        if (!name || !protocol) return;
        this.protocols[String(name).toLowerCase()] = protocol;
    };

    AispAgentClient.prototype.connect = function () {
        if (!this.ws) return Promise.resolve();
        return this.ws.connect();
    };

    AispAgentClient.prototype.disconnect = function () {
        if (!this.ws) return;
        this.ws.close();
    };

    AispAgentClient.prototype.listTools = function () {
        var keys = [];
        var k;
        for (k in this.toolAdapters) keys.push(k);
        return Promise.resolve(keys);
    };

    AispAgentClient.prototype.executeTool = function (toolName, payload, options) {
        options = options || {};
        var name = String(toolName || '').toLowerCase();
        var adapter = this.toolAdapters[name];
        if (!adapter) return Promise.reject(new Error('Unknown tool adapter: ' + name));
        if (options.transport === 'ws') {
            if (!this.ws) return Promise.reject(new Error('WebSocket not configured'));
            return this.connect().then(function () {
                return this.ws.request('tool.execute', { tool: name, payload: payload || {} }, options.timeoutMs);
            }.bind(this));
        }
        return adapter.execute(this, payload || {});
    };

    AispAgentClient.prototype.runAgentTask = function (protocolName, goal, context, options) {
        options = options || {};
        var name = String(protocolName || '').toLowerCase();
        var protocol = this.protocols[name];
        if (!protocol) return Promise.reject(new Error('Unknown protocol: ' + name));
        var task = protocol.buildTask(goal, context || {});
        if (options.transport === 'ws') {
            if (!this.ws) return Promise.reject(new Error('WebSocket not configured'));
            return this.connect().then(function () {
                return this.ws.request('agent.run', { protocol: name, task: task }, options.timeoutMs);
            }.bind(this));
        }
        return this.rest.request('POST', '/agent/run', { protocol: name, task: task });
    };

    function bindIntroCards(root) {
        root = root || global.document;
        if (!root || !root.querySelectorAll) return;
        var cards = root.querySelectorAll('.module-card[data-module="AispAgent"]');
        for (var i = 0; i < cards.length; i++) {
            (function (card) {
                if (card.__aispBound) return;
                card.__aispBound = true;
                card.addEventListener('click', function (evt) {
                    var target = evt.target;
                    if (target && target.tagName && String(target.tagName).toLowerCase() === 'a') return;
                    var link = card.querySelector('a[href]');
                    if (link && link.href) {
                        if (link.target === '_blank') global.open(link.href, '_blank');
                        else global.location.href = link.getAttribute('href');
                    }
                });
            })(cards[i]);
        }
    }

    function createTestSuite() {
        function assert(cond, message) {
            if (!cond) throw new Error(message || 'Assertion failed');
        }

        function run() {
            var tests = [];
            function test(name, fn) { tests.push({ name: name, fn: fn }); }

            test('Logger buffers entries', function () {
                var logger = new Logger({ level: 'debug', bufferSize: 2 });
                logger.debug('a');
                logger.debug('b');
                logger.debug('c');
                var entries = logger.getEntries();
                assert(entries.length === 2, 'buffer size');
                assert(entries[0].message === 'b', 'oldest dropped');
                assert(entries[1].message === 'c', 'latest kept');
            });

            test('RestTransport builds JSON request', function () {
                var captured = {};
                var fakeFetch = function (url, opts) {
                    captured.url = url;
                    captured.opts = opts;
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: { get: function () { return 'application/json'; } },
                        json: function () { return Promise.resolve({ ok: true }); }
                    });
                };
                var logger = new Logger({ level: 'silent' });
                var rest = new RestTransport({ baseUrl: 'http://example.com', fetchImpl: fakeFetch, logger: logger });
                return rest.request('POST', '/x', { a: 1 }).then(function (data) {
                    assert(data && data.ok === true, 'response data');
                    assert(captured.url === 'http://example.com/x', 'url join');
                    assert(captured.opts && captured.opts.method === 'POST', 'method');
                    assert(!!captured.opts.body, 'body present');
                });
            });

            test('WsTransport correlates responses', function () {
                function FakeWs(url) {
                    this.url = url;
                    this.readyState = 1;
                    this.sent = [];
                }
                FakeWs.prototype.send = function (msg) { this.sent.push(msg); };
                FakeWs.prototype.close = function () { this.readyState = 3; };

                var logger = new Logger({ level: 'silent' });
                var ws = new WsTransport({ url: 'ws://example', WebSocketImpl: FakeWs, logger: logger, reconnect: false });
                ws.socket = new FakeWs('ws://example');
                var p = ws.request('x', { a: 1 }, 2000);
                var sent = ws.socket.sent[0];
                var parsed = JSON.parse(sent);
                ws._handleMessage(JSON.stringify({ type: 'response', id: parsed.id, payload: { ok: true } }));
                return p.then(function (data) {
                    assert(data && data.ok === true, 'ws response payload');
                });
            });

            var start = nowMs();
            var results = [];
            var chain = Promise.resolve();
            for (var i = 0; i < tests.length; i++) {
                (function (t) {
                    chain = chain.then(function () {
                        var t0 = nowMs();
                        return Promise.resolve().then(function () { return t.fn(); }).then(function () {
                            results.push({ name: t.name, ok: true, ms: Math.round(nowMs() - t0) });
                        }).catch(function (e) {
                            results.push({ name: t.name, ok: false, error: String(e && e.message ? e.message : e), ms: Math.round(nowMs() - t0) });
                        });
                    });
                })(tests[i]);
            }

            return chain.then(function () {
                var passed = 0;
                for (var j = 0; j < results.length; j++) if (results[j].ok) passed++;
                return {
                    passed: passed,
                    failed: results.length - passed,
                    total: results.length,
                    durationMs: Math.round(nowMs() - start),
                    results: results
                };
            });
        }

        function benchmark() {
            var t0 = nowMs();
            var n = 5000;
            var obj = { a: 1, b: 'x', c: [1, 2, 3], d: { e: true } };
            var s = '';
            for (var i = 0; i < n; i++) s = safeJsonStringify(obj);
            var t1 = nowMs();
            var parsed = null;
            for (var j = 0; j < n; j++) parsed = JSON.parse(s);
            var t2 = nowMs();
            return {
                iterations: n,
                stringifyMs: Math.round(t1 - t0),
                parseMs: Math.round(t2 - t1),
                sample: parsed && parsed.d && parsed.d.e === true
            };
        }

        return { run: run, benchmark: benchmark };
    }

    AispAgent.Logger = Logger;
    AispAgent.RestTransport = RestTransport;
    AispAgent.WsTransport = WsTransport;
    AispAgent.AispAgentClient = AispAgentClient;
    AispAgent.createClient = function (options) { return new AispAgentClient(options || {}); };
    AispAgent.bindIntroCards = bindIntroCards;
    AispAgent.tests = createTestSuite();

    global.AispAgent = AispAgent;

    if (global.document && global.document.addEventListener) {
        global.document.addEventListener('DOMContentLoaded', function () {
            try { bindIntroCards(global.document); } catch (e) {}
        });
    }
})(window);

