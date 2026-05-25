/**
 * Entity card renderers — one function per domain.
 * Each function receives the state object and the HAClient instance,
 * and returns an HTMLElement.
 */

class EntityCardFactory {
    constructor(haClient) {
        this.haClient = haClient;
    }

    createCard(state) {
        const domain = state.entity_id.split('.')[0];
        const el = this._makeBaseCard(state, domain);

        const renderer = this[`_render_${domain}`];
        if (renderer) {
            renderer.call(this, el, state);
        } else {
            this._renderGeneric(el, state);
        }

        return el;
    }

    // ─── Base card shell ───────────────────────────────────────────────

    _makeBaseCard(state, domain) {
        const isOn = this._isOn(state);
        const isUnavailable = state.state === 'unavailable' || state.state === 'unknown';
        const cfg = DOMAIN_CONFIG[domain] || { icon: '❓', label: domain };

        const card = document.createElement('div');
        card.className = 'entity-card' + (isOn ? ' on' : '') + (isUnavailable ? ' unavailable' : '');
        card.dataset.entityId = state.entity_id;
        card.dataset.domain = domain;

        const name = state.attributes?.friendly_name || state.entity_id.split('.')[1].replace(/_/g, ' ');

        card.innerHTML = `
            <div class="card-top">
                <div class="card-icon">${cfg.icon}</div>
                <div class="card-state-badge ${isOn ? 'on' : ''}">${isUnavailable ? 'N/A' : state.state}</div>
            </div>
            <div class="card-info">
                <div class="card-name">${this._esc(name)}</div>
                <div class="card-state dim"></div>
            </div>
        `;

        return card;
    }

    _isOn(state) {
        return ['on', 'open', 'playing', 'home', 'unlocked', 'active', 'heat', 'cool',
                'heat_cool', 'fan_only', 'dry', 'auto', 'armed_away', 'armed_home',
                'true', 'unavailable'].includes(state.state) === false
            ? ['on', 'open', 'playing', 'home', 'unlocked', 'true'].includes(state.state)
            : ['on', 'open', 'playing', 'home', 'unlocked'].includes(state.state);
    }

    _esc(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    _callService(domain, service, entityId, extra = {}) {
        this.haClient.callService(domain, service, { entity_id: entityId, ...extra })
            .catch(err => showToast('Service call failed: ' + err.message, 'error'));
    }

    // ─── Domain renderers ──────────────────────────────────────────────

    _render_light(card, state) {
        const isOn = state.state === 'on';
        const brightness = state.attributes?.brightness;
        const brightnessPercent = brightness != null ? Math.round(brightness / 255 * 100) : null;
        const colorTemp = state.attributes?.color_temp;

        const stateEl = card.querySelector('.card-state');
        stateEl.textContent = isOn
            ? (brightnessPercent != null ? `${brightnessPercent}%` : 'On')
            : 'Off';

        // Toggle button
        const toggle = document.createElement('button');
        toggle.className = 'card-toggle' + (isOn ? ' on' : '');
        toggle.title = isOn ? 'Turn off' : 'Turn on';
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._callService('light', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
        card.appendChild(toggle);

        // Brightness bar
        if (isOn && brightnessPercent != null) {
            const bar = document.createElement('div');
            bar.className = 'brightness-bar';
            bar.style.width = brightnessPercent + '%';
            card.appendChild(bar);
        }

        card.addEventListener('click', () => {
            this._callService('light', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
    }

    _render_switch(card, state) {
        const isOn = state.state === 'on';
        const stateEl = card.querySelector('.card-state');
        stateEl.textContent = isOn ? 'On' : 'Off';

        const toggle = document.createElement('button');
        toggle.className = 'card-toggle' + (isOn ? ' on' : '');
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._callService('switch', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
        card.appendChild(toggle);

        card.addEventListener('click', () => {
            this._callService('switch', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
    }

    _render_input_boolean(card, state) {
        this._render_switch(card, state); // same behavior
    }

    _render_fan(card, state) {
        const isOn = state.state === 'on';
        const speed = state.attributes?.percentage;
        const stateEl = card.querySelector('.card-state');
        stateEl.textContent = isOn ? (speed != null ? `${speed}%` : 'On') : 'Off';

        const toggle = document.createElement('button');
        toggle.className = 'card-toggle' + (isOn ? ' on' : '');
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._callService('fan', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
        card.appendChild(toggle);

        card.addEventListener('click', () => {
            this._callService('fan', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
    }

    _render_lock(card, state) {
        const isLocked = state.state === 'locked';
        const stateEl = card.querySelector('.card-state');
        stateEl.textContent = isLocked ? 'Locked' : 'Unlocked';
        if (!isLocked) card.classList.add('warning');

        card.addEventListener('click', () => {
            this._callService('lock', isLocked ? 'unlock' : 'lock', state.entity_id);
        });
    }

    _render_sensor(card, state) {
        const unit = state.attributes?.unit_of_measurement || '';
        const stateEl = card.querySelector('.card-state');
        const val = parseFloat(state.state);
        stateEl.className = 'card-state';
        stateEl.textContent = isNaN(val) ? state.state : `${state.state}${unit}`;

        const devClass = state.attributes?.device_class;
        // Warn thresholds for common sensors
        if (devClass === 'battery' && val < 20) card.classList.add('warning');
        if (devClass === 'carbon_monoxide' && val > 35) card.classList.add('danger');
        if (devClass === 'temperature') {
            if (val > 38) card.classList.add('danger');
            else if (val < 5) card.classList.add('warning');
        }

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none'; // hide state badge for sensors
    }

    _render_binary_sensor(card, state) {
        const isOn = state.state === 'on';
        const devClass = state.attributes?.device_class;
        const stateEl = card.querySelector('.card-state');
        const badge = card.querySelector('.card-state-badge');

        const labels = {
            motion: ['Motion', 'Clear'],
            door: ['Open', 'Closed'],
            window: ['Open', 'Closed'],
            smoke: ['Detected', 'Clear'],
            moisture: ['Wet', 'Dry'],
            presence: ['Detected', 'Clear'],
            occupancy: ['Occupied', 'Clear'],
            plug: ['Plugged', 'Unplugged'],
            battery: ['Low', 'Normal'],
            gas: ['Detected', 'Clear'],
        };

        const [onLabel, offLabel] = labels[devClass] || ['On', 'Off'];
        stateEl.className = 'card-state dim';
        stateEl.textContent = isOn ? onLabel : offLabel;
        badge.style.display = 'none';

        if (isOn) {
            const alertDomains = ['smoke', 'gas', 'moisture', 'carbon_monoxide'];
            if (alertDomains.includes(devClass)) card.classList.add('danger');
        }
    }

    _render_climate(card, state) {
        card.classList.add('card-wide');
        const currentTemp = state.attributes?.current_temperature;
        const targetTemp = state.attributes?.temperature;
        const unit = state.attributes?.temperature_unit || '°C';
        const hvacMode = state.state;

        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state';
        stateEl.innerHTML = '';

        const climateDiv = document.createElement('div');
        climateDiv.className = 'climate-temps';
        climateDiv.innerHTML = `
            <span class="climate-current">${currentTemp != null ? currentTemp + unit : '—'}</span>
            <span class="climate-target">→ ${targetTemp != null ? targetTemp + unit : '—'}</span>
        `;
        const modeDiv = document.createElement('div');
        modeDiv.className = 'climate-mode';
        modeDiv.textContent = hvacMode;

        stateEl.appendChild(climateDiv);
        stateEl.appendChild(modeDiv);

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_weather(card, state) {
        card.classList.add('card-wide');
        const temp = state.attributes?.temperature;
        const unit = state.attributes?.temperature_unit || '°C';
        const humidity = state.attributes?.humidity;
        const wind = state.attributes?.wind_speed;
        const windUnit = state.attributes?.wind_speed_unit || 'km/h';
        const pressure = state.attributes?.pressure;
        const condition = state.state;

        const weatherIcons = {
            'clear-night': '🌙', sunny: '☀️', partlycloudy: '⛅', cloudy: '☁️',
            rainy: '🌧️', snowy: '🌨️', lightning: '⛈️', fog: '🌫️',
            hail: '🌩️', windy: '💨', exceptional: '⚠️'
        };
        const icon = weatherIcons[condition] || '🌡️';

        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state';
        stateEl.innerHTML = `
            <div class="weather-card-content">
                <div class="weather-icon">${icon}</div>
                <div>
                    <div class="weather-temp">${temp != null ? temp + unit : '—'}</div>
                    <div class="weather-condition">${condition}</div>
                </div>
            </div>
            <div class="weather-details">
                ${humidity != null ? `<span>💧 ${humidity}%</span>` : ''}
                ${wind != null ? `<span>💨 ${wind} ${windUnit}</span>` : ''}
                ${pressure != null ? `<span>🔴 ${pressure} hPa</span>` : ''}
            </div>
        `;

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_media_player(card, state) {
        card.classList.add('card-wide');
        const isPlaying = state.state === 'playing';
        const isPaused = state.state === 'paused';
        const mediaTitle = state.attributes?.media_title;
        const mediaArtist = state.attributes?.media_artist;
        const position = state.attributes?.media_position;
        const duration = state.attributes?.media_duration;

        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state';
        stateEl.innerHTML = `
            <div class="media-card-content">
                <div class="media-title">${this._esc(mediaTitle || state.attributes?.friendly_name || 'Media Player')}</div>
                ${mediaArtist ? `<div class="media-artist">${this._esc(mediaArtist)}</div>` : ''}
                <div class="media-controls">
                    <button class="media-btn" data-action="media_previous_track" title="Previous">⏮</button>
                    <button class="media-btn play" data-action="${isPlaying ? 'media_pause' : 'media_play'}" title="${isPlaying ? 'Pause' : 'Play'}">
                        ${isPlaying ? '⏸' : '▶'}
                    </button>
                    <button class="media-btn" data-action="media_next_track" title="Next">⏭</button>
                    <button class="media-btn" data-action="${state.state !== 'off' ? 'turn_off' : 'turn_on'}" title="Power">${state.state !== 'off' ? '⏻' : '⏼'}</button>
                </div>
                ${duration ? `<div class="progress-bar"><div class="progress-fill" style="width:${(position/duration*100)||0}%"></div></div>` : ''}
            </div>
        `;

        stateEl.querySelectorAll('.media-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (['turn_on','turn_off'].includes(action)) {
                    this._callService('media_player', action, state.entity_id);
                } else {
                    this._callService('media_player', action, state.entity_id);
                }
            });
        });

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_cover(card, state) {
        const isOpen = state.state === 'open';
        const position = state.attributes?.current_position;
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = isOpen ? `Open${position != null ? ` (${position}%)` : ''}` : 'Closed';

        const controls = document.createElement('div');
        controls.className = 'cover-controls';
        controls.innerHTML = `
            <button class="cover-btn" data-action="open_cover" title="Open">▲</button>
            <button class="cover-btn" data-action="stop_cover" title="Stop">■</button>
            <button class="cover-btn" data-action="close_cover" title="Close">▼</button>
        `;
        controls.querySelectorAll('.cover-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._callService('cover', btn.dataset.action, state.entity_id);
            });
        });
        card.querySelector('.card-info').appendChild(controls);
    }

    _render_person(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        const isHome = state.state === 'home';
        stateEl.textContent = isHome ? 'Home' : (state.state || 'Away');
        if (isHome) card.classList.add('person-home');

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_device_tracker(card, state) {
        this._render_person(card, state);
    }

    _render_automation(card, state) {
        const isOn = state.state === 'on';
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = isOn ? 'Enabled' : 'Disabled';

        const toggle = document.createElement('button');
        toggle.className = 'card-toggle' + (isOn ? ' on' : '');
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._callService('automation', isOn ? 'turn_off' : 'turn_on', state.entity_id);
        });
        card.appendChild(toggle);

        card.addEventListener('click', () => {
            this._callService('automation', 'trigger', state.entity_id);
        });
    }

    _render_script(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = state.state === 'on' ? 'Running…' : 'Idle';

        card.addEventListener('click', () => {
            this._callService('script', 'turn_on', state.entity_id);
        });
    }

    _render_scene(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = 'Tap to activate';

        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';

        card.addEventListener('click', () => {
            this._callService('scene', 'turn_on', state.entity_id);
            showToast('Scene activated');
        });
    }

    _render_input_number(card, state) {
        const unit = state.attributes?.unit_of_measurement || '';
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state';
        stateEl.textContent = `${state.state}${unit}`;
        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_input_select(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = state.state;
        const badge = card.querySelector('.card-state-badge');
        badge.style.display = 'none';
    }

    _render_timer(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = state.attributes?.remaining || state.state;
    }

    _render_alarm_control_panel(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = state.state.replace(/_/g, ' ');
        if (!['disarmed', 'unknown'].includes(state.state)) card.classList.add('danger');
    }

    _render_vacuum(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        const battery = state.attributes?.battery_level;
        stateEl.textContent = state.state + (battery != null ? ` (${battery}%)` : '');

        if (state.state === 'docked' || state.state === 'idle') {
            card.addEventListener('click', () => {
                this._callService('vacuum', 'start', state.entity_id);
            });
        } else {
            card.addEventListener('click', () => {
                this._callService('vacuum', 'return_to_base', state.entity_id);
            });
        }
    }

    _renderGeneric(card, state) {
        const stateEl = card.querySelector('.card-state');
        stateEl.className = 'card-state dim';
        stateEl.textContent = state.state;
    }
}
