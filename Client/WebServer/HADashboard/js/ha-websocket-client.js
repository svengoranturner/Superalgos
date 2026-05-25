/**
 * Home Assistant WebSocket API Client
 * Handles connection, authentication, subscriptions, and service calls.
 */

class HAWebSocketClient {
    constructor() {
        this.ws = null;
        this.msgId = 1;
        this.pendingRequests = new Map();
        this.subscriptions = new Map();
        this.authenticated = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;

        this.onConnected = null;
        this.onDisconnected = null;
        this.onStateChanged = null;
        this.onError = null;

        this._config = null;
    }

    connect(config) {
        this._config = config;
        this._openSocket();
    }

    disconnect() {
        this.reconnectAttempts = Infinity; // prevent reconnect
        clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.authenticated = false;
    }

    _openSocket() {
        const { host, port, ssl, token } = this._config;
        const protocol = ssl ? 'wss' : 'ws';
        const url = `${protocol}://${host}:${port}/api/websocket`;

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            // HA sends auth_required first; handled in onmessage
        };

        this.ws.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            this._handleMessage(msg, token);
        };

        this.ws.onclose = () => {
            this.authenticated = false;
            if (this.onDisconnected) this.onDisconnected();
            this._scheduleReconnect();
        };

        this.ws.onerror = () => {
            if (this.onError) this.onError('Connection error');
        };
    }

    _handleMessage(msg, token) {
        switch (msg.type) {
            case 'auth_required':
                this._send({ type: 'auth', access_token: token });
                break;

            case 'auth_ok':
                this.authenticated = true;
                this.reconnectAttempts = 0;
                if (this.onConnected) this.onConnected();
                break;

            case 'auth_invalid':
                if (this.onError) this.onError('Authentication failed — check your access token');
                this.disconnect();
                break;

            case 'result': {
                const req = this.pendingRequests.get(msg.id);
                if (req) {
                    this.pendingRequests.delete(msg.id);
                    if (msg.success) {
                        req.resolve(msg.result);
                    } else {
                        req.reject(new Error(msg.error?.message || 'Request failed'));
                    }
                }
                break;
            }

            case 'event': {
                const sub = this.subscriptions.get(msg.id);
                if (sub) sub(msg.event);
                break;
            }
        }
    }

    _send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    _request(payload) {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.pendingRequests.set(id, { resolve, reject });
            this._send({ ...payload, id });
        });
    }

    _scheduleReconnect() {
        if (this.reconnectAttempts === Infinity) return;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.reconnectAttempts++;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this._openSocket(), delay);
    }

    // ─── HA API Methods ────────────────────────────────────────────────

    async getStates() {
        return this._request({ type: 'get_states' });
    }

    async getAreaRegistry() {
        return this._request({ type: 'config/area_registry/list' });
    }

    async getDeviceRegistry() {
        return this._request({ type: 'config/device_registry/list' });
    }

    async getEntityRegistry() {
        return this._request({ type: 'config/entity_registry/list' });
    }

    async callService(domain, service, serviceData = {}) {
        return this._request({
            type: 'call_service',
            domain,
            service,
            service_data: serviceData,
            return_response: false
        });
    }

    subscribeStateChanges() {
        const id = this.msgId++;
        this._send({ id, type: 'subscribe_events', event_type: 'state_changed' });
        this.pendingRequests.set(id, {
            resolve: () => {},
            reject: () => {}
        });
        this.subscriptions.set(id, (event) => {
            if (this.onStateChanged) this.onStateChanged(event.data);
        });
    }
}
