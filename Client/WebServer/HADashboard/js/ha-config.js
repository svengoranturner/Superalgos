/**
 * Configuration manager — persists connection settings and dashboard
 * customization to localStorage.
 */

class HAConfigManager {
    constructor() {
        this._storageKey = 'ha_dashboard_config';
        this._cfg = this._load();
    }

    _load() {
        try {
            const raw = localStorage.getItem(this._storageKey);
            return raw ? JSON.parse(raw) : this._defaults();
        } catch {
            return this._defaults();
        }
    }

    _defaults() {
        return {
            connection: { host: 'homeassistant.local', port: 8123, ssl: false, token: '' },
            hiddenDomains: {},
            hiddenEntities: {},
            hiddenAreas: {},
            areaOrder: [],
            showUnavailable: false,
            groupByArea: true
        };
    }

    _save() {
        try {
            localStorage.setItem(this._storageKey, JSON.stringify(this._cfg));
        } catch {}
    }

    get connection() { return this._cfg.connection; }
    set connection(val) { this._cfg.connection = val; this._save(); }

    isConnected() {
        return !!(this._cfg.connection?.token && this._cfg.connection?.host);
    }

    /** Customization getters/setters */
    get hiddenDomains() { return this._cfg.hiddenDomains; }
    get hiddenEntities() { return this._cfg.hiddenEntities; }
    get hiddenAreas() { return this._cfg.hiddenAreas; }
    get showUnavailable() { return this._cfg.showUnavailable; }
    get groupByArea() { return this._cfg.groupByArea; }

    toggleDomainVisibility(domain) {
        this._cfg.hiddenDomains[domain] = !this._cfg.hiddenDomains[domain];
        if (!this._cfg.hiddenDomains[domain]) delete this._cfg.hiddenDomains[domain];
        this._save();
    }

    toggleEntityVisibility(entityId) {
        this._cfg.hiddenEntities[entityId] = !this._cfg.hiddenEntities[entityId];
        if (!this._cfg.hiddenEntities[entityId]) delete this._cfg.hiddenEntities[entityId];
        this._save();
    }

    toggleAreaVisibility(areaId) {
        this._cfg.hiddenAreas[areaId] = !this._cfg.hiddenAreas[areaId];
        if (!this._cfg.hiddenAreas[areaId]) delete this._cfg.hiddenAreas[areaId];
        this._save();
    }

    setShowUnavailable(val) {
        this._cfg.showUnavailable = val;
        this._save();
    }

    setGroupByArea(val) {
        this._cfg.groupByArea = val;
        this._save();
    }

    clearConnection() {
        this._cfg = this._defaults();
        this._save();
    }

    /** Returns a plain config object suitable for passing to EntityRegistry queries */
    getQueryConfig() {
        return {
            hiddenDomains: this._cfg.hiddenDomains,
            hiddenEntities: this._cfg.hiddenEntities,
            hiddenAreas: this._cfg.hiddenAreas,
            showUnavailable: this._cfg.showUnavailable
        };
    }
}
