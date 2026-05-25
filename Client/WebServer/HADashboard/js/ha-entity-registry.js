/**
 * Entity Registry — holds and indexes all entity states and area info.
 * Drives auto-discovery and live updates.
 */

class HAEntityRegistry {
    constructor() {
        this.states = new Map();       // entityId → state object
        this.areas = new Map();        // areaId → { name, entities[] }
        this.entityMeta = new Map();   // entityId → { area_id, device_id }
        this.deviceMeta = new Map();   // deviceId → { area_id }

        this.onChange = null;  // callback(changeType, entityId, state)
    }

    // ─── Load initial data ─────────────────────────────────────────────

    loadStates(states) {
        this.states.clear();
        for (const s of states) {
            this.states.set(s.entity_id, s);
        }
    }

    loadAreaRegistry(areas) {
        this.areas.clear();
        for (const a of areas) {
            this.areas.set(a.area_id, { id: a.area_id, name: a.name, aliases: a.aliases || [], icon: a.icon || null });
        }
        if (!this.areas.has('__unassigned')) {
            this.areas.set('__unassigned', { id: '__unassigned', name: 'Other', icon: null });
        }
    }

    loadEntityRegistry(entities) {
        this.entityMeta.clear();
        for (const e of entities) {
            this.entityMeta.set(e.entity_id, { area_id: e.area_id, device_id: e.device_id, hidden_by: e.hidden_by });
        }
    }

    loadDeviceRegistry(devices) {
        this.deviceMeta.clear();
        for (const d of devices) {
            this.deviceMeta.set(d.id, { area_id: d.area_id });
        }
    }

    // ─── Live updates ──────────────────────────────────────────────────

    applyStateChange(newState, oldState) {
        const entityId = newState ? newState.entity_id : oldState?.entity_id;
        if (!entityId) return;

        if (newState) {
            const prev = this.states.get(entityId);
            this.states.set(entityId, newState);
            const changeType = prev ? 'updated' : 'added';
            if (this.onChange) this.onChange(changeType, entityId, newState);
        } else {
            this.states.delete(entityId);
            if (this.onChange) this.onChange('removed', entityId, null);
        }
    }

    // ─── Query helpers ─────────────────────────────────────────────────

    getEntityState(entityId) {
        return this.states.get(entityId);
    }

    /** Returns the area id for an entity, falling back to device area, then 'unassigned' */
    getEntityAreaId(entityId) {
        const meta = this.entityMeta.get(entityId);
        if (meta?.area_id) return meta.area_id;
        if (meta?.device_id) {
            const dev = this.deviceMeta.get(meta.device_id);
            if (dev?.area_id) return dev.area_id;
        }
        return '__unassigned';
    }

    getDomain(entityId) {
        return entityId.split('.')[0];
    }

    isHidden(entityId) {
        const meta = this.entityMeta.get(entityId);
        return meta?.hidden_by != null;
    }

    /**
     * Returns entities grouped by area.
     * { areaId: { area, entities: [ state ] } }
     */
    getGroupedByArea(domainFilter = null, searchQuery = '', customConfig = {}) {
        const groups = new Map();

        for (const [entityId, state] of this.states) {
            if (this.isHidden(entityId)) continue;

            const domain = this.getDomain(entityId);
            if (!DOMAIN_CONFIG[domain]) continue;  // unknown domain
            if (customConfig.hiddenDomains?.[domain]) continue;
            if (customConfig.hiddenEntities?.[entityId]) continue;
            if (domainFilter && domain !== domainFilter) continue;

            const name = state.attributes?.friendly_name || entityId;
            if (searchQuery && !name.toLowerCase().includes(searchQuery.toLowerCase())) continue;

            const areaId = this.getEntityAreaId(entityId);
            if (customConfig.hiddenAreas?.[areaId]) continue;

            if (!groups.has(areaId)) {
                const area = this.areas.get(areaId) || { id: areaId, name: 'Other' };
                groups.set(areaId, { area, entities: [] });
            }
            groups.get(areaId).entities.push(state);
        }

        // Sort entities within each area by domain priority, then name
        for (const group of groups.values()) {
            group.entities.sort((a, b) => {
                const da = DOMAIN_CONFIG[this.getDomain(a.entity_id)]?.priority ?? 99;
                const db = DOMAIN_CONFIG[this.getDomain(b.entity_id)]?.priority ?? 99;
                if (da !== db) return da - db;
                const na = a.attributes?.friendly_name || a.entity_id;
                const nb = b.attributes?.friendly_name || b.entity_id;
                return na.localeCompare(nb);
            });
        }

        // Sort areas: unassigned last, then alphabetically
        return new Map([...groups.entries()].sort(([idA, a], [idB, b]) => {
            if (idA === '__unassigned') return 1;
            if (idB === '__unassigned') return -1;
            return a.area.name.localeCompare(b.area.name);
        }));
    }

    /**
     * Returns counts per domain (for sidebar).
     */
    getDomainCounts() {
        const counts = {};
        for (const [entityId, state] of this.states) {
            if (this.isHidden(entityId)) continue;
            const domain = this.getDomain(entityId);
            counts[domain] = (counts[domain] || 0) + 1;
        }
        return counts;
    }

    getAreaList() {
        const areaIds = new Set();
        for (const entityId of this.states.keys()) {
            areaIds.add(this.getEntityAreaId(entityId));
        }
        return [...areaIds].map(id => this.areas.get(id) || { id, name: 'Other' });
    }
}

/**
 * Domain configuration — priority (lower = shown first), icon, label.
 */
const DOMAIN_CONFIG = {
    light:          { priority: 1,  icon: '💡', label: 'Lights' },
    switch:         { priority: 2,  icon: '🔌', label: 'Switches' },
    climate:        { priority: 3,  icon: '🌡️', label: 'Climate' },
    cover:          { priority: 4,  icon: '🪟', label: 'Covers' },
    media_player:   { priority: 5,  icon: '🎵', label: 'Media' },
    camera:         { priority: 6,  icon: '📷', label: 'Cameras' },
    sensor:         { priority: 7,  icon: '📊', label: 'Sensors' },
    binary_sensor:  { priority: 8,  icon: '🔔', label: 'Binary Sensors' },
    weather:        { priority: 9,  icon: '⛅', label: 'Weather' },
    person:         { priority: 10, icon: '👤', label: 'People' },
    device_tracker: { priority: 11, icon: '📍', label: 'Trackers' },
    automation:     { priority: 12, icon: '⚡', label: 'Automations' },
    script:         { priority: 13, icon: '📜', label: 'Scripts' },
    scene:          { priority: 14, icon: '🎭', label: 'Scenes' },
    input_boolean:  { priority: 15, icon: '🔘', label: 'Input Booleans' },
    input_number:   { priority: 16, icon: '🔢', label: 'Input Numbers' },
    input_select:   { priority: 17, icon: '📋', label: 'Input Selects' },
    timer:          { priority: 18, icon: '⏱️', label: 'Timers' },
    fan:            { priority: 19, icon: '🌀', label: 'Fans' },
    lock:           { priority: 20, icon: '🔒', label: 'Locks' },
    alarm_control_panel: { priority: 21, icon: '🚨', label: 'Alarm' },
    water_heater:   { priority: 22, icon: '🚿', label: 'Water Heater' },
    vacuum:         { priority: 23, icon: '🤖', label: 'Vacuums' },
};
