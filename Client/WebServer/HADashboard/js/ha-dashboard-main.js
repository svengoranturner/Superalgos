/**
 * HA Dashboard — main orchestrator.
 * Wires together client, registry, card factory, and UI rendering.
 */

class HADashboard {
    constructor() {
        this.config = new HAConfigManager();
        this.client = new HAWebSocketClient();
        this.registry = new HAEntityRegistry();
        this.cardFactory = new EntityCardFactory(this.client);

        this.activeFilter = null;  // domain filter or null = all
        this.searchQuery = '';
        this.customizeOpen = false;

        // Debounced render
        this._renderTimer = null;
        this._pendingUpdates = new Set();

        this._init();
    }

    _init() {
        this._bindUIEvents();

        if (this.config.isConnected()) {
            this._showDashboard();
            this._connect();
        } else {
            this._showSetup();
        }
    }

    // ─── Connection ────────────────────────────────────────────────────

    _connect() {
        const conn = this.config.connection;

        this.client.onConnected = async () => {
            this._setStatus('connected', 'Connected');
            try {
                const [states, areas, entities, devices] = await Promise.all([
                    this.client.getStates(),
                    this.client.getAreaRegistry().catch(() => []),
                    this.client.getEntityRegistry().catch(() => []),
                    this.client.getDeviceRegistry().catch(() => [])
                ]);

                this.registry.loadStates(states);
                this.registry.loadAreaRegistry(areas);
                this.registry.loadEntityRegistry(entities);
                this.registry.loadDeviceRegistry(devices);

                this.client.subscribeStateChanges();

                this._renderSidebar();
                this._renderMain();
            } catch (err) {
                showToast('Failed to load data: ' + err.message, 'error');
            }
        };

        this.client.onDisconnected = () => {
            this._setStatus('', 'Reconnecting…');
        };

        this.client.onError = (msg) => {
            this._setStatus('error', msg);
            showToast(msg, 'error');
        };

        this.registry.onChange = (type, entityId, state) => {
            this._pendingUpdates.add(entityId);
            clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => {
                this._applyUpdates();
                this._pendingUpdates.clear();
            }, 150);
        };

        this.client.connect(conn);
        this._setStatus('', 'Connecting…');
    }

    _applyUpdates() {
        // Try to update individual cards first (cheaper than full re-render)
        let needFullRender = false;

        for (const entityId of this._pendingUpdates) {
            const card = document.querySelector(`[data-entity-id="${entityId}"]`);
            const state = this.registry.getEntityState(entityId);

            if (!card && state) {
                // New entity — need full render to insert in correct position
                needFullRender = true;
                break;
            }

            if (card && !state) {
                // Entity removed
                const section = card.closest('.area-section');
                card.remove();
                if (section && section.querySelectorAll('.entity-card').length === 0) {
                    section.remove();
                }
                continue;
            }

            if (card && state) {
                // Replace card in-place
                const newCard = this.cardFactory.createCard(state);
                card.replaceWith(newCard);
            }
        }

        if (needFullRender) {
            this._renderMain();
        }

        // Always refresh sidebar counts
        this._renderSidebarCounts();
    }

    // ─── UI Sections ───────────────────────────────────────────────────

    _showSetup() {
        document.getElementById('setup-screen').style.display = 'flex';
        document.getElementById('main-dashboard').style.display = 'none';
        document.getElementById('ha-sidebar').classList.add('hidden');
    }

    _showDashboard() {
        document.getElementById('setup-screen').style.display = 'none';
        document.getElementById('main-dashboard').style.display = 'flex';
        document.getElementById('ha-sidebar').classList.remove('hidden');
    }

    _setStatus(type, text) {
        const dot = document.getElementById('status-dot');
        const txt = document.getElementById('status-text');
        dot.className = 'status-dot' + (type ? ' ' + type : '');
        txt.textContent = text;
    }

    // ─── Render ────────────────────────────────────────────────────────

    _renderMain() {
        const main = document.getElementById('ha-main-content');
        main.innerHTML = '';

        const grouped = this.registry.getGroupedByArea(
            this.activeFilter,
            this.searchQuery,
            this.config.getQueryConfig()
        );

        if (grouped.size === 0) {
            main.innerHTML = `
                <div class="empty-state">
                    <div class="icon">🏠</div>
                    <p>No entities found.<br>Check your filters or connection.</p>
                </div>`;
            return;
        }

        for (const [areaId, { area, entities }] of grouped) {
            const section = document.createElement('div');
            section.className = 'area-section';
            section.dataset.areaId = areaId;

            const areaHeader = document.createElement('div');
            areaHeader.className = 'area-header';
            areaHeader.innerHTML = `
                <h2>${area.icon ? area.icon + ' ' : ''}${this._esc(area.name)}</h2>
                <span class="area-meta">${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}</span>
            `;
            section.appendChild(areaHeader);

            const grid = document.createElement('div');
            grid.className = 'entity-grid';

            for (const state of entities) {
                if (state.state === 'unavailable' && !this.config.showUnavailable) continue;
                const card = this.cardFactory.createCard(state);
                grid.appendChild(card);
            }

            if (grid.childElementCount === 0) continue;

            section.appendChild(grid);
            main.appendChild(section);
        }
    }

    _renderSidebar() {
        this._renderSidebarCounts();
        this._renderAreaSidebar();
    }

    _renderSidebarCounts() {
        const counts = this.registry.getDomainCounts();
        const domainList = document.getElementById('sidebar-domains');
        domainList.innerHTML = '';

        // "All" item
        const allItem = this._makeSidebarItem('all', '🏠', 'All Entities',
            Object.values(counts).reduce((a, b) => a + b, 0),
            this.activeFilter === null
        );
        allItem.addEventListener('click', () => {
            this.activeFilter = null;
            this._highlightSidebarItem(allItem);
            this._renderMain();
        });
        domainList.appendChild(allItem);

        const sortedDomains = Object.entries(counts)
            .filter(([d]) => DOMAIN_CONFIG[d])
            .sort(([a], [b]) => (DOMAIN_CONFIG[a]?.priority ?? 99) - (DOMAIN_CONFIG[b]?.priority ?? 99));

        for (const [domain, count] of sortedDomains) {
            const cfg = DOMAIN_CONFIG[domain];
            const item = this._makeSidebarItem(domain, cfg.icon, cfg.label, count, this.activeFilter === domain);
            item.addEventListener('click', () => {
                this.activeFilter = domain;
                this._highlightSidebarItem(item);
                this._renderMain();
            });
            domainList.appendChild(item);
        }
    }

    _renderAreaSidebar() {
        const areaList = document.getElementById('sidebar-areas');
        areaList.innerHTML = '';

        const areas = this.registry.getAreaList();
        for (const area of areas) {
            const item = this._makeSidebarItem('area-' + area.id, area.icon || '📍', area.name, null, false);
            item.addEventListener('click', () => {
                const section = document.querySelector(`[data-area-id="${area.id}"]`);
                if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                this._highlightSidebarItem(item);
            });
            areaList.appendChild(item);
        }
    }

    _makeSidebarItem(id, icon, label, count, isActive) {
        const item = document.createElement('div');
        item.className = 'sidebar-item' + (isActive ? ' active' : '');
        item.dataset.itemId = id;
        item.innerHTML = `
            <span class="item-icon">${icon}</span>
            <span>${this._esc(label)}</span>
            ${count != null ? `<span class="item-count">${count}</span>` : ''}
        `;
        return item;
    }

    _highlightSidebarItem(el) {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        el.classList.add('active');
    }

    // ─── Customization drawer ──────────────────────────────────────────

    _openCustomize() {
        const overlay = document.getElementById('customize-overlay');
        const drawer = document.getElementById('customize-drawer');
        this._renderCustomizeDrawer();
        overlay.classList.add('open');
        drawer.classList.add('open');
        this.customizeOpen = true;
    }

    _closeCustomize() {
        document.getElementById('customize-overlay').classList.remove('open');
        document.getElementById('customize-drawer').classList.remove('open');
        this.customizeOpen = false;
    }

    _renderCustomizeDrawer() {
        const body = document.getElementById('customize-body');
        body.innerHTML = '';

        // ── Domains section
        const domainSection = document.createElement('div');
        domainSection.className = 'drawer-section';
        domainSection.innerHTML = '<h4>Entity Types</h4>';

        const counts = this.registry.getDomainCounts();
        const domains = Object.entries(counts).filter(([d]) => DOMAIN_CONFIG[d])
            .sort(([a], [b]) => (DOMAIN_CONFIG[a]?.priority ?? 99) - (DOMAIN_CONFIG[b]?.priority ?? 99));

        for (const [domain, count] of domains) {
            const cfg = DOMAIN_CONFIG[domain];
            const hidden = this.config.hiddenDomains[domain];
            const row = this._makeToggleRow(
                `${cfg.icon} ${cfg.label}`,
                `${count} entit${count === 1 ? 'y' : 'ies'}`,
                !hidden,
                () => {
                    this.config.toggleDomainVisibility(domain);
                    this._renderMain();
                    this._renderSidebarCounts();
                }
            );
            domainSection.appendChild(row);
        }
        body.appendChild(domainSection);

        // ── Areas section
        const areaSection = document.createElement('div');
        areaSection.className = 'drawer-section';
        areaSection.innerHTML = '<h4>Areas / Rooms</h4>';

        const areas = this.registry.getAreaList();
        for (const area of areas) {
            const hidden = this.config.hiddenAreas[area.id];
            const row = this._makeToggleRow(
                `${area.icon || '📍'} ${area.name}`,
                '',
                !hidden,
                () => {
                    this.config.toggleAreaVisibility(area.id);
                    this._renderMain();
                }
            );
            areaSection.appendChild(row);
        }
        body.appendChild(areaSection);

        // ── Options section
        const optSection = document.createElement('div');
        optSection.className = 'drawer-section';
        optSection.innerHTML = '<h4>Options</h4>';

        optSection.appendChild(this._makeToggleRow(
            'Show unavailable entities', '',
            this.config.showUnavailable,
            (val) => { this.config.setShowUnavailable(val); this._renderMain(); }
        ));

        body.appendChild(optSection);
    }

    _makeToggleRow(label, sub, isOn, onChange) {
        const row = document.createElement('div');
        row.className = 'toggle-row';

        const labelDiv = document.createElement('div');
        labelDiv.innerHTML = `<div class="toggle-row-label">${this._esc(label)}</div>${sub ? `<div class="toggle-row-sub">${this._esc(sub)}</div>` : ''}`;

        const toggle = document.createElement('button');
        toggle.className = 'toggle-switch' + (isOn ? ' on' : '');
        toggle.addEventListener('click', () => {
            const nowOn = toggle.classList.toggle('on');
            onChange(nowOn);
        });

        row.appendChild(labelDiv);
        row.appendChild(toggle);
        return row;
    }

    // ─── Event binding ─────────────────────────────────────────────────

    _bindUIEvents() {
        // Setup form
        document.getElementById('setup-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this._handleSetupSubmit();
        });

        // Customize button
        document.getElementById('btn-customize')?.addEventListener('click', () => this._openCustomize());

        // Overlay / close button
        document.getElementById('customize-overlay')?.addEventListener('click', () => this._closeCustomize());
        document.getElementById('btn-close-drawer')?.addEventListener('click', () => this._closeCustomize());

        // Reset customize
        document.getElementById('btn-reset-customize')?.addEventListener('click', () => {
            if (confirm('Reset all visibility settings?')) {
                this.config._cfg.hiddenDomains = {};
                this.config._cfg.hiddenEntities = {};
                this.config._cfg.hiddenAreas = {};
                this.config._save();
                this._closeCustomize();
                this._renderMain();
                this._renderSidebar();
            }
        });

        // Disconnect button
        document.getElementById('btn-disconnect')?.addEventListener('click', () => {
            if (confirm('Disconnect and clear saved connection?')) {
                this.client.disconnect();
                this.config.clearConnection();
                this._showSetup();
                this._setStatus('', '');
            }
        });

        // Search
        document.getElementById('search-input')?.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.trim();
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this._renderMain(), 200);
        });

        // Sidebar toggle (mobile)
        document.getElementById('btn-menu')?.addEventListener('click', () => {
            document.getElementById('ha-sidebar').classList.toggle('mobile-open');
        });

        // Close mobile sidebar on main click
        document.getElementById('ha-main-content')?.addEventListener('click', () => {
            document.getElementById('ha-sidebar').classList.remove('mobile-open');
        });
    }

    _handleSetupSubmit() {
        const host = document.getElementById('input-host').value.trim();
        const port = parseInt(document.getElementById('input-port').value) || 8123;
        const ssl = document.getElementById('input-ssl').value === 'true';
        const token = document.getElementById('input-token').value.trim();
        const errorEl = document.getElementById('setup-error');

        if (!host || !token) {
            errorEl.textContent = 'Host and access token are required.';
            errorEl.classList.add('visible');
            return;
        }

        errorEl.classList.remove('visible');
        this.config.connection = { host, port, ssl, token };

        this._showDashboard();

        const main = document.getElementById('ha-main-content');
        main.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

        this._connect();
    }

    _esc(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
}

// ─── Toast utility ─────────────────────────────────────────────────────

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast' + (type !== 'info' ? ' ' + type : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ─── Bootstrap ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    window.haDashboard = new HADashboard();
});
