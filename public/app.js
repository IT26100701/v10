// ============================================
// TRAVA. — Frontend Logic
// ============================================

const CONFIG = {
    REFRESH_INTERVAL: 30000,
    TOAST_DURATION: 3000,
    MAX_LOGS: 100
};

const state = {
    token: localStorage.getItem('token') || '',
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    commands: [],
    pairings: [],
    adminSessions: [],
    adminUsers: [],
    currentPage: 'dashboard',
    loading: false
};

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    if (!state.token) {
        window.location.href = '/login';
        return;
    }
    setupNavigation();
    setupKeyboard();
    initDashboardBoard();
    initClock();
    syncSidebarAccessibility();
    window.addEventListener('resize', syncSidebarAccessibility);
    loadUser();
    loadAll();
    setInterval(() => {
        if (!state.loading) loadStats();
    }, CONFIG.REFRESH_INTERVAL);
});

// ==================== AUTH ====================
async function loadUser() {
    try {
        const data = await apiCall('/api/auth/me');
        state.user = data.user;
        localStorage.setItem('user', JSON.stringify(data.user));
        renderUserInfo();
    } catch (e) {
        if (e.message.includes('401') || e.message.includes('Invalid')) logout();
    }
}

function renderUserInfo() {
    const u = state.user;
    if (!u) return;

    setText('sidebarUsername', u.username);
    setText('sidebarAvatar', (u.username[0] || 'U').toUpperCase());
    setText('homeGreeting', u.username);
    setText('homePlan', u.tier.toUpperCase());

    const tierEl = document.getElementById('sidebarTier');
    if (tierEl) {
        tierEl.textContent = u.tier.toUpperCase();
        tierEl.className = 'user-tier ' + u.tier;
    }

    setText('infoUsername', u.username);
    setText('infoTier', u.tier.toUpperCase());
    setText('statExpiry', u.tier.toUpperCase());
    let expiry = u.tier === 'free' ? 'Not applicable' : 'No expiry';
    if (u.expiresAt) {
        const date = new Date(u.expiresAt);
        if (!Number.isNaN(date.getTime())) {
            expiry = new Intl.DateTimeFormat('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Colombo'
            }).format(date);
        }
    }
    setText('infoExpiry', expiry);

    const adminGroup = document.getElementById('adminGroup');
    if (adminGroup) adminGroup.style.display = u.tier === 'admin' ? '' : 'none';

    let rule = '';
    if (u.tier === 'admin') rule = 'All sessions (admin)';
    else if (u.tier === 'premium') rule = 'Bot sessions (no pairing)';
    else if (u.tier === 'reseller') rule = 'Bot sessions (reseller)';
    else rule = 'Must pair your WhatsApp';
    setText('infoRule', rule);
}

// ==================== HOME CLOCK ====================
const homeClock = { customTime: null, timeZone: null, country: null };

// IANA tzdb zone.tab maps a device time zone to a country without a network request.
const TIME_ZONE_COUNTRIES = new Map(`
Africa/Abidjan CI
Africa/Accra GH
Africa/Addis_Ababa ET
Africa/Algiers DZ
Africa/Asmara ER
Africa/Bamako ML
Africa/Bangui CF
Africa/Banjul GM
Africa/Bissau GW
Africa/Blantyre MW
Africa/Brazzaville CG
Africa/Bujumbura BI
Africa/Cairo EG
Africa/Casablanca MA
Africa/Ceuta ES
Africa/Conakry GN
Africa/Dakar SN
Africa/Dar_es_Salaam TZ
Africa/Djibouti DJ
Africa/Douala CM
Africa/El_Aaiun EH
Africa/Freetown SL
Africa/Gaborone BW
Africa/Harare ZW
Africa/Johannesburg ZA
Africa/Juba SS
Africa/Kampala UG
Africa/Khartoum SD
Africa/Kigali RW
Africa/Kinshasa CD
Africa/Lagos NG
Africa/Libreville GA
Africa/Lome TG
Africa/Luanda AO
Africa/Lubumbashi CD
Africa/Lusaka ZM
Africa/Malabo GQ
Africa/Maputo MZ
Africa/Maseru LS
Africa/Mbabane SZ
Africa/Mogadishu SO
Africa/Monrovia LR
Africa/Nairobi KE
Africa/Ndjamena TD
Africa/Niamey NE
Africa/Nouakchott MR
Africa/Ouagadougou BF
Africa/Porto-Novo BJ
Africa/Sao_Tome ST
Africa/Tripoli LY
Africa/Tunis TN
Africa/Windhoek NA
America/Adak US
America/Anchorage US
America/Anguilla AI
America/Antigua AG
America/Araguaina BR
America/Argentina/Buenos_Aires AR
America/Argentina/Catamarca AR
America/Argentina/Cordoba AR
America/Argentina/Jujuy AR
America/Argentina/La_Rioja AR
America/Argentina/Mendoza AR
America/Argentina/Rio_Gallegos AR
America/Argentina/Salta AR
America/Argentina/San_Juan AR
America/Argentina/San_Luis AR
America/Argentina/Tucuman AR
America/Argentina/Ushuaia AR
America/Aruba AW
America/Asuncion PY
America/Atikokan CA
America/Bahia BR
America/Bahia_Banderas MX
America/Barbados BB
America/Belem BR
America/Belize BZ
America/Blanc-Sablon CA
America/Boa_Vista BR
America/Bogota CO
America/Boise US
America/Cambridge_Bay CA
America/Campo_Grande BR
America/Cancun MX
America/Caracas VE
America/Cayenne GF
America/Cayman KY
America/Chicago US
America/Chihuahua MX
America/Ciudad_Juarez MX
America/Costa_Rica CR
America/Coyhaique CL
America/Creston CA
America/Cuiaba BR
America/Curacao CW
America/Danmarkshavn GL
America/Dawson CA
America/Dawson_Creek CA
America/Denver US
America/Detroit US
America/Dominica DM
America/Edmonton CA
America/Eirunepe BR
America/El_Salvador SV
America/Fort_Nelson CA
America/Fortaleza BR
America/Glace_Bay CA
America/Goose_Bay CA
America/Grand_Turk TC
America/Grenada GD
America/Guadeloupe GP
America/Guatemala GT
America/Guayaquil EC
America/Guyana GY
America/Halifax CA
America/Havana CU
America/Hermosillo MX
America/Indiana/Indianapolis US
America/Indiana/Knox US
America/Indiana/Marengo US
America/Indiana/Petersburg US
America/Indiana/Tell_City US
America/Indiana/Vevay US
America/Indiana/Vincennes US
America/Indiana/Winamac US
America/Inuvik CA
America/Iqaluit CA
America/Jamaica JM
America/Juneau US
America/Kentucky/Louisville US
America/Kentucky/Monticello US
America/Kralendijk BQ
America/La_Paz BO
America/Lima PE
America/Los_Angeles US
America/Lower_Princes SX
America/Maceio BR
America/Managua NI
America/Manaus BR
America/Marigot MF
America/Martinique MQ
America/Matamoros MX
America/Mazatlan MX
America/Menominee US
America/Merida MX
America/Metlakatla US
America/Mexico_City MX
America/Miquelon PM
America/Moncton CA
America/Monterrey MX
America/Montevideo UY
America/Montserrat MS
America/Nassau BS
America/New_York US
America/Nome US
America/Noronha BR
America/North_Dakota/Beulah US
America/North_Dakota/Center US
America/North_Dakota/New_Salem US
America/Nuuk GL
America/Ojinaga MX
America/Panama PA
America/Paramaribo SR
America/Phoenix US
America/Port-au-Prince HT
America/Port_of_Spain TT
America/Porto_Velho BR
America/Puerto_Rico PR
America/Punta_Arenas CL
America/Rankin_Inlet CA
America/Recife BR
America/Regina CA
America/Resolute CA
America/Rio_Branco BR
America/Santarem BR
America/Santiago CL
America/Santo_Domingo DO
America/Sao_Paulo BR
America/Scoresbysund GL
America/Sitka US
America/St_Barthelemy BL
America/St_Johns CA
America/St_Kitts KN
America/St_Lucia LC
America/St_Thomas VI
America/St_Vincent VC
America/Swift_Current CA
America/Tegucigalpa HN
America/Thule GL
America/Tijuana MX
America/Toronto CA
America/Tortola VG
America/Vancouver CA
America/Whitehorse CA
America/Winnipeg CA
America/Yakutat US
Antarctica/Casey AQ
Antarctica/Davis AQ
Antarctica/DumontDUrville AQ
Antarctica/Macquarie AU
Antarctica/Mawson AQ
Antarctica/McMurdo AQ
Antarctica/Palmer AQ
Antarctica/Rothera AQ
Antarctica/Syowa AQ
Antarctica/Troll AQ
Antarctica/Vostok AQ
Arctic/Longyearbyen SJ
Asia/Aden YE
Asia/Almaty KZ
Asia/Amman JO
Asia/Anadyr RU
Asia/Aqtau KZ
Asia/Aqtobe KZ
Asia/Ashgabat TM
Asia/Atyrau KZ
Asia/Baghdad IQ
Asia/Bahrain BH
Asia/Baku AZ
Asia/Bangkok TH
Asia/Barnaul RU
Asia/Beirut LB
Asia/Bishkek KG
Asia/Brunei BN
Asia/Chita RU
Asia/Colombo LK
Asia/Damascus SY
Asia/Dhaka BD
Asia/Dili TL
Asia/Dubai AE
Asia/Dushanbe TJ
Asia/Famagusta CY
Asia/Gaza PS
Asia/Hebron PS
Asia/Ho_Chi_Minh VN
Asia/Hong_Kong HK
Asia/Hovd MN
Asia/Irkutsk RU
Asia/Jakarta ID
Asia/Jayapura ID
Asia/Jerusalem IL
Asia/Kabul AF
Asia/Kamchatka RU
Asia/Karachi PK
Asia/Kathmandu NP
Asia/Khandyga RU
Asia/Kolkata IN
Asia/Krasnoyarsk RU
Asia/Kuala_Lumpur MY
Asia/Kuching MY
Asia/Kuwait KW
Asia/Macau MO
Asia/Magadan RU
Asia/Makassar ID
Asia/Manila PH
Asia/Muscat OM
Asia/Nicosia CY
Asia/Novokuznetsk RU
Asia/Novosibirsk RU
Asia/Omsk RU
Asia/Oral KZ
Asia/Phnom_Penh KH
Asia/Pontianak ID
Asia/Pyongyang KP
Asia/Qatar QA
Asia/Qostanay KZ
Asia/Qyzylorda KZ
Asia/Riyadh SA
Asia/Sakhalin RU
Asia/Samarkand UZ
Asia/Seoul KR
Asia/Shanghai CN
Asia/Singapore SG
Asia/Srednekolymsk RU
Asia/Taipei TW
Asia/Tashkent UZ
Asia/Tbilisi GE
Asia/Tehran IR
Asia/Thimphu BT
Asia/Tokyo JP
Asia/Tomsk RU
Asia/Ulaanbaatar MN
Asia/Urumqi CN
Asia/Ust-Nera RU
Asia/Vientiane LA
Asia/Vladivostok RU
Asia/Yakutsk RU
Asia/Yangon MM
Asia/Yekaterinburg RU
Asia/Yerevan AM
Atlantic/Azores PT
Atlantic/Bermuda BM
Atlantic/Canary ES
Atlantic/Cape_Verde CV
Atlantic/Faroe FO
Atlantic/Madeira PT
Atlantic/Reykjavik IS
Atlantic/South_Georgia GS
Atlantic/St_Helena SH
Atlantic/Stanley FK
Australia/Adelaide AU
Australia/Brisbane AU
Australia/Broken_Hill AU
Australia/Darwin AU
Australia/Eucla AU
Australia/Hobart AU
Australia/Lindeman AU
Australia/Lord_Howe AU
Australia/Melbourne AU
Australia/Perth AU
Australia/Sydney AU
Europe/Amsterdam NL
Europe/Andorra AD
Europe/Astrakhan RU
Europe/Athens GR
Europe/Belgrade RS
Europe/Berlin DE
Europe/Bratislava SK
Europe/Brussels BE
Europe/Bucharest RO
Europe/Budapest HU
Europe/Busingen DE
Europe/Chisinau MD
Europe/Copenhagen DK
Europe/Dublin IE
Europe/Gibraltar GI
Europe/Guernsey GG
Europe/Helsinki FI
Europe/Isle_of_Man IM
Europe/Istanbul TR
Europe/Jersey JE
Europe/Kaliningrad RU
Europe/Kirov RU
Europe/Kyiv UA
Europe/Lisbon PT
Europe/Ljubljana SI
Europe/London GB
Europe/Luxembourg LU
Europe/Madrid ES
Europe/Malta MT
Europe/Mariehamn AX
Europe/Minsk BY
Europe/Monaco MC
Europe/Moscow RU
Europe/Oslo NO
Europe/Paris FR
Europe/Podgorica ME
Europe/Prague CZ
Europe/Riga LV
Europe/Rome IT
Europe/Samara RU
Europe/San_Marino SM
Europe/Sarajevo BA
Europe/Saratov RU
Europe/Simferopol UA
Europe/Skopje MK
Europe/Sofia BG
Europe/Stockholm SE
Europe/Tallinn EE
Europe/Tirane AL
Europe/Ulyanovsk RU
Europe/Vaduz LI
Europe/Vatican VA
Europe/Vienna AT
Europe/Vilnius LT
Europe/Volgograd RU
Europe/Warsaw PL
Europe/Zagreb HR
Europe/Zurich CH
Indian/Antananarivo MG
Indian/Chagos IO
Indian/Christmas CX
Indian/Cocos CC
Indian/Comoro KM
Indian/Kerguelen TF
Indian/Mahe SC
Indian/Maldives MV
Indian/Mauritius MU
Indian/Mayotte YT
Indian/Reunion RE
Pacific/Apia WS
Pacific/Auckland NZ
Pacific/Bougainville PG
Pacific/Chatham NZ
Pacific/Chuuk FM
Pacific/Easter CL
Pacific/Efate VU
Pacific/Fakaofo TK
Pacific/Fiji FJ
Pacific/Funafuti TV
Pacific/Galapagos EC
Pacific/Gambier PF
Pacific/Guadalcanal SB
Pacific/Guam GU
Pacific/Honolulu US
Pacific/Kanton KI
Pacific/Kiritimati KI
Pacific/Kosrae FM
Pacific/Kwajalein MH
Pacific/Majuro MH
Pacific/Marquesas PF
Pacific/Midway UM
Pacific/Nauru NR
Pacific/Niue NU
Pacific/Norfolk NF
Pacific/Noumea NC
Pacific/Pago_Pago AS
Pacific/Palau PW
Pacific/Pitcairn PN
Pacific/Pohnpei FM
Pacific/Port_Moresby PG
Pacific/Rarotonga CK
Pacific/Saipan MP
Pacific/Tahiti PF
Pacific/Tarawa KI
Pacific/Tongatapu TO
Pacific/Wake UM
Pacific/Wallis WF
`.trim().split('\n').map(entry => entry.split(' ')));

function countryFromDeviceTimeZone(timeZone) {
    const language = navigator.language || 'en';
    let region = TIME_ZONE_COUNTRIES.get(timeZone) || null;

    // Some devices report a newer alias absent from the bundled tzdb list.
    if (!region && timeZone && typeof Intl.Locale === 'function' && 'timeZones' in Intl.Locale.prototype) {
        try {
            const matches = [];
            for (let first = 65; first <= 90; first++) {
                for (let second = 65; second <= 90; second++) {
                    const code = String.fromCharCode(first, second);
                    if (new Intl.Locale(`en-${code}`).timeZones?.includes(timeZone)) matches.push(code);
                }
            }
            if (matches.length === 1) region = matches[0];
        } catch (_) { /* Keep the country unavailable if the time zone cannot be matched. */ }
    }
    if (!region) return { name: 'Unavailable', source: 'unknown' };
    try { return { name: new Intl.DisplayNames([language], { type: 'region' }).of(region) || region, source: 'timeZone' }; }
    catch (_) { return { name: region, source: 'timeZone' }; }
}

function clockNowValue() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function renderClock() {
    const face = document.querySelector('.clock-face');
    const digital = document.getElementById('clockDigital');
    const input = document.getElementById('clockTimeInput');
    const mode = document.getElementById('clockMode');
    const country = document.getElementById('clockCountry');
    if (!face || !digital || !input || !mode || !country) return;

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (timeZone !== homeClock.timeZone) {
        homeClock.timeZone = timeZone;
        homeClock.country = countryFromDeviceTimeZone(timeZone);
    }

    const value = homeClock.customTime || clockNowValue();
    const [hours, minutes] = value.split(':').map(Number);
    face.style.setProperty('--hour-angle', `${(hours % 12) * 30 + minutes * .5}deg`);
    face.style.setProperty('--minute-angle', `${minutes * 6}deg`);
    digital.textContent = value;
    digital.setAttribute('datetime', value);
    mode.textContent = homeClock.customTime ? 'Custom time' : 'Live local time';
    country.textContent = homeClock.country.name;
    country.title = homeClock.country.source === 'timeZone' ? `Based on device time zone: ${timeZone}` :
        'Country unavailable from device time zone';
    if (document.activeElement !== input) input.value = value;
}

function initClock() {
    const input = document.getElementById('clockTimeInput');
    const reset = document.getElementById('clockNow');
    if (!input || !reset) return;

    localStorage.removeItem('trava-clock-time');
    const setCustomTime = () => {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.value)) return;
        homeClock.customTime = input.value;
        renderClock();
    };
    input.addEventListener('input', setCustomTime);
    input.addEventListener('change', setCustomTime);
    input.addEventListener('blur', renderClock);
    reset.addEventListener('click', () => {
        homeClock.customTime = null;
        input.blur();
        renderClock();
    });
    renderClock();
    setInterval(renderClock, 10000);
}

// ==================== DASHBOARD CARDS ====================
function initDashboardBoard() {
    const groups = document.querySelectorAll('#view-dashboard [data-board-group]');
    const status = document.getElementById('boardOrderStatus');
    if (!groups.length) return;

    const cardsIn = group => Array.from(group.children).filter(child => child.matches('.board-card'));
    const saveOrder = group => {
        const ids = cardsIn(group).map(card => card.dataset.cardId);
        try { localStorage.setItem(`trava-board-${group.dataset.boardGroup}`, JSON.stringify(ids)); } catch (_) {}
    };

    groups.forEach(group => {
        const key = `trava-board-${group.dataset.boardGroup}`;
        try {
            const saved = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(saved)) {
                saved.forEach(id => {
                    const card = cardsIn(group).find(item => item.dataset.cardId === id);
                    if (card) group.appendChild(card);
                });
            }
        } catch (_) { /* Use the default order when saved data is unavailable. */ }

        cardsIn(group).forEach(card => {
            const grip = document.createElement('button');
            grip.type = 'button';
            grip.className = 'card-grip';
            grip.setAttribute('aria-label', `Move ${card.dataset.cardLabel} card. Use arrow keys to reorder.`);
            grip.title = 'Drag to rearrange';
            card.prepend(grip);
        });

        group.addEventListener('keydown', event => {
            const grip = event.target.closest('.card-grip');
            if (!grip || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const card = grip.closest('.board-card');
            const cards = cardsIn(group);
            const index = cards.indexOf(card);
            const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
            const next = cards[index + direction];
            if (!next) return;
            event.preventDefault();
            if (direction < 0) group.insertBefore(card, next);
            else group.insertBefore(card, next.nextSibling);
            saveOrder(group);
            grip.focus();
            if (status) status.textContent = `${card.dataset.cardLabel} moved to position ${index + direction + 1}.`;
            card.classList.add('is-tapped');
            setTimeout(() => card.classList.remove('is-tapped'), 450);
        });

        group.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !(event.target instanceof Element)) return;
            const card = event.target.closest('.board-card');
            if (!card || card.parentElement !== group) return;
            const grip = event.target.closest('.card-grip');
            if (!grip && event.target.closest('button, input, select, textarea, a, label')) return;
            if (grip || event.pointerType === 'mouse') event.preventDefault();

            card.classList.remove('is-tapped');
            card.classList.add('is-pressed');
            const startX = event.clientX;
            const startY = event.clientY;
            const canDrag = Boolean(grip) || event.pointerType === 'mouse';
            let dragging = false;
            let target = null;
            let dropSide = null;
            const controller = new AbortController();

            const findTarget = (x, y) => {
                const element = document.elementFromPoint(x, y);
                const candidate = element?.closest('.board-card');
                return candidate && candidate !== card && candidate.parentElement === group ? candidate : null;
            };
            const placementFor = (candidate, x, y) => {
                const box = candidate.getBoundingClientRect();
                const groupBox = group.getBoundingClientRect();
                const vertical = box.width > groupBox.width * .78;
                const midX = box.left + box.width / 2;
                const midY = box.top + box.height / 2;
                const before = vertical ? y < midY :
                    Math.abs(y - midY) < box.height / 3 ? x < midX : y < midY;
                return { before, vertical };
            };
            const clearTarget = () => {
                target?.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after', 'is-drop-vertical');
                target = null;
                dropSide = null;
            };
            const onMove = move => {
                if (move.pointerId !== event.pointerId) return;
                const dx = move.clientX - startX;
                const dy = move.clientY - startY;
                if (!dragging && canDrag && Math.hypot(dx, dy) > 8) {
                    dragging = true;
                    card.classList.remove('is-pressed');
                    card.classList.add('is-dragging');
                }
                if (!dragging) return;
                move.preventDefault();
                card.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.015)`;
                const nextTarget = findTarget(move.clientX, move.clientY);
                const nextPlace = nextTarget ? placementFor(nextTarget, move.clientX, move.clientY) : null;
                const nextSide = nextPlace ? (nextPlace.before ? 'before' : 'after') : null;
                if (nextTarget !== target || nextSide !== dropSide) {
                    clearTarget();
                    target = nextTarget;
                    dropSide = nextSide;
                    if (target) {
                        target.classList.add('is-drop-target', `is-drop-${dropSide}`);
                        if (nextPlace.vertical) target.classList.add('is-drop-vertical');
                        if (status) status.textContent = `Place ${card.dataset.cardLabel} ${dropSide} ${target.dataset.cardLabel}.`;
                    }
                }
            };
            const finish = up => {
                if (up.pointerId !== event.pointerId) return;
                controller.abort();
                const destination = dragging && up.type === 'pointerup' ? findTarget(up.clientX, up.clientY) : null;
                if (destination) {
                    const { before } = placementFor(destination, up.clientX, up.clientY);
                    group.insertBefore(card, before ? destination : destination.nextSibling);
                    saveOrder(group);
                    if (status) status.textContent = `${card.dataset.cardLabel} moved.`;
                }
                clearTarget();
                card.classList.remove('is-pressed', 'is-dragging');
                card.style.transform = '';
                if (up.type === 'pointerup' && (!dragging || destination)) {
                    card.classList.add('is-tapped');
                    setTimeout(() => card.classList.remove('is-tapped'), 450);
                }
            };
            window.addEventListener('pointermove', onMove, { signal: controller.signal, passive: false });
            window.addEventListener('pointerup', finish, { signal: controller.signal });
            window.addEventListener('pointercancel', finish, { signal: controller.signal });
        });
    });
}

// ==================== API ====================
async function apiCall(endpoint, method = 'GET', body = null) {
    if (!state.token) { logout(); throw new Error('No token'); }
    const opts = {
        method,
        headers: {
            'Authorization': 'Bearer ' + state.token,
            'Content-Type': 'application/json'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(endpoint, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ==================== NAVIGATION ====================
function setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.page);
        });
    });
}

function navigateTo(page) {
    if (!page) return;
    state.currentPage = page;

    document.querySelectorAll('.nav-item').forEach(l => {
        const active = l.dataset.page === page;
        l.classList.toggle('active', active);
        if (active) l.setAttribute('aria-current', 'page');
        else l.removeAttribute('aria-current');
    });
    document.querySelectorAll('.page').forEach(p =>
        p.classList.toggle('active', p.id === `view-${page}`)
    );

    const titles = {
        dashboard: ['Dashboard', 'Overview & quick actions'],
        attack: ['doom', 'Advanced kiss configuration'],
        pairing: ['My Pairings', 'Manage your WhatsApp sessions'],
        premium: ['Premium', 'Upgrade your account'],
        'admin-sessions': ['All Sessions', 'Manage all paired WhatsApp numbers'],
        'admin-users': ['Users', 'Manage all users'],
        'admin-logs': ['Logs', 'Recent API activity']
    };
    const [t, s] = titles[page] || ['Dashboard', ''];
    setText('pageTitle', t);
    setText('pageSubtitle', s);
    document.body.dataset.page = page;

    if (window.innerWidth <= 768) toggleSidebar(false);

    if (page === 'attack') loadCommands();
    if (page === 'pairing') loadPairings();
    if (page === 'admin-sessions') loadAdminSessions();
    if (page === 'admin-users') loadAdminUsers();
    if (page === 'admin-logs') loadLogs();
}

function toggleSidebar(force) {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (!sidebar || !backdrop) return;
    const open = window.innerWidth <= 768 &&
        (force !== undefined ? Boolean(force) : !sidebar.classList.contains('open'));
    const focusWasInside = sidebar.contains(document.activeElement);
    sidebar.classList.toggle('open', open);
    backdrop.classList.toggle('show', open);
    document.body.classList.toggle('menu-open', open);
    syncSidebarAccessibility();
    if (open) sidebar.querySelector('.sidebar-close')?.focus();
    else if (focusWasInside) document.querySelector('.hamburger')?.focus();
}

function syncSidebarAccessibility() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    const main = document.getElementById('main');
    const menuButton = document.querySelector('.hamburger');
    if (!sidebar || !menuButton) return;
    const mobile = window.innerWidth <= 768;
    if (!mobile) {
        sidebar.classList.remove('open');
        backdrop?.classList.remove('show');
        document.body.classList.remove('menu-open');
    }
    const open = mobile && sidebar.classList.contains('open');
    sidebar.inert = mobile && !open;
    if (main) main.inert = open;
    backdrop?.setAttribute('aria-hidden', String(!open));
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}

// ==================== KEYBOARD ====================
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') toggleSidebar(false);
    });
}

// ==================== LOAD ALL ====================
async function loadAll() {
    await Promise.all([loadStats(), loadCommands()]);
}

async function loadStats() {
    try {
        const data = await apiCall('/api/stats');
        setText('statUserSessions', data.userSessions);
        setText('statTotalAttacks', data.totalAttacks);
        setText('statBotSessions', data.botSessions);
    } catch (e) { console.error(e); }
}

async function loadCommands() {
    try {
        const data = await apiCall('/api/commands');
        state.commands = data.commands || [];
        const q = document.getElementById('quickAttackType');
        const cards = document.getElementById('attackTypeCards');
        const previous = cards?.querySelector('input[name="attackType"]:checked')?.value;
        if (q) q.replaceChildren();
        if (cards) cards.replaceChildren();

        state.commands.forEach((command, index) => {
            const type = String(command.attackType ?? '');
            const name = String(command.cmdName ?? type);
            const platform = String(command.platform ?? 'Command');
            if (q) q.add(new Option(`${name} (${platform})`, type));
            if (!cards) return;

            const card = document.createElement('label');
            card.className = 'command-card';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'attackType';
            radio.value = type;
            radio.checked = previous === type;
            radio.setAttribute('aria-describedby', `command-meta-${index}`);

            const title = document.createElement('span');
            title.className = 'command-card-title';
            title.textContent = name;
            const meta = document.createElement('span');
            meta.className = 'command-card-meta';
            meta.id = `command-meta-${index}`;
            meta.textContent = platform;
            const stateLabel = document.createElement('span');
            stateLabel.className = 'command-card-state';
            stateLabel.setAttribute('aria-hidden', 'true');
            const selectLabel = document.createElement('span');
            selectLabel.className = 'select-label';
            selectLabel.textContent = 'Select';
            const selectedLabel = document.createElement('span');
            selectedLabel.className = 'selected-label';
            selectedLabel.textContent = 'Selected';
            stateLabel.append(selectLabel, selectedLabel);
            card.append(radio, title, meta, stateLabel);
            cards.append(card);
        });
        if (cards && !state.commands.length) {
            const empty = document.createElement('p');
            empty.className = 'command-empty';
            empty.textContent = 'No kiss types are available yet.';
            cards.append(empty);
        }
    } catch (e) { console.error(e); }
}

// ==================== ATTACK ====================
async function quickAttack(event) {
    const attackType = document.getElementById('quickAttackType').value;
    const target = document.getElementById('quickTarget').value.trim();
    const count = parseInt(document.getElementById('quickCount').value);
    const result = document.getElementById('quickResult');
    const btn = event?.currentTarget || event?.target;

    if (!attackType) return actionValidationError(result, 'quickAttackType', 'Choose a kiss type');
    if (!target) return actionValidationError(result, 'quickTarget', 'Enter a WhatsApp number with country code');
    if (!Number.isInteger(count) || count < 1 || count > 100) return actionValidationError(result, 'quickCount', 'Send count must be between 1 and 100');

    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.textContent = 'Sending...';
    btn.setAttribute('aria-busy', 'true');
    showResult(result, 'info', 'Sending quick kiss...');
    const start = Date.now();

    try {
        const data = await apiCall('/api/attack', 'POST', { attackType, target, count });
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        showResult(result, 'success',
            `SUCCESS (${elapsed}s)\n\nSent:   ${data.result.success}\nFailed: ${data.result.failed}\nTotal:  ${data.result.total}`
        );
        toast('Quick kiss sent', 'success');
        loadStats();
    } catch (e) {
        showResult(result, 'error', `${e.message}`);
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
        btn.removeAttribute('aria-busy');
    }
}

async function sendAttack(event) {
    const attackType = document.querySelector('input[name="attackType"]:checked')?.value || '';
    const target = document.getElementById('attackTarget').value.trim();
    const count = parseInt(document.getElementById('attackCount').value);
    const result = document.getElementById('attackResult');
    const btn = event?.currentTarget || event?.target;

    if (!attackType) return actionValidationError(result, 'attackTypeCards', 'Choose a kiss type');
    if (!target) return actionValidationError(result, 'attackTarget', 'Enter a WhatsApp number with country code');
    if (!Number.isInteger(count) || count < 1 || count > 100) return actionValidationError(result, 'attackCount', 'Loops must be between 1 and 100');

    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.textContent = 'Sending...';
    btn.setAttribute('aria-busy', 'true');
    showResult(result, 'info', 'Sending full kiss...');
    const start = Date.now();

    try {
        const data = await apiCall('/api/attack', 'POST', { attackType, target, count });
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        showResult(result, 'success',
            `COMPLETE (${elapsed}s)\n\nType:   ${attackType}\nNumber: ${target}\nSent:   ${data.result.success}\nFailed: ${data.result.failed}`
        );
        toast('Full kiss sent', 'success');
        loadStats();
    } catch (e) {
        showResult(result, 'error', `${e.message}`);
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
        btn.removeAttribute('aria-busy');
    }
}

// ==================== PAIRING ====================
async function loadPairings() {
    try {
        const data = await apiCall('/api/pair/sessions');
        state.pairings = data.sessions || [];
        renderPairings();
        setText('badgePairings', state.pairings.length);
        setText('statUserSessions', state.pairings.length);
    } catch (e) { console.error(e); }
}

function renderPairings() {
    const el = document.getElementById('pairingList');
    if (!el) return;
    if (state.pairings.length === 0) {
        el.innerHTML = emptyState('No pairings', 'Pair your WhatsApp to start attacking');
        return;
    }
    el.innerHTML = state.pairings.map(p => `
        <div class="list-item">
            <div class="list-content">
                <div class="list-title">+${p.number}</div>
                <div class="list-sub">Status: Connected</div>
            </div>
            <div class="list-actions">
                <button class="list-btn danger" onclick="deletePairing('${p.number}')" title="Delete">Delete</button>
            </div>
        </div>
    `).join('');
}

async function requestPair(event) {
    const number = document.getElementById('pairNumber').value.trim();
    const display = document.getElementById('pairCodeDisplay');
    const btn = event?.target;

    if (!number) return toast('Enter number', 'error');

    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = 'Requesting...';

    try {
        const data = await apiCall('/api/pair/request', 'POST', { number });
        display.className = 'pair-code show';
        display.innerHTML = `
            <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:1px;font-weight:700;">Pair Code</div>
            <div class="pair-code-value">${data.code}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:8px;">Enter this in WhatsApp → Linked Devices</div>
        `;
        toast('Pair code generated', 'success');
    } catch (e) {
        toast(e.message, 'error');
        display.className = 'pair-code';
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

async function deletePairing(number) {
    if (!confirm(`Delete pairing +${number}?`)) return;
    try {
        await apiCall('/api/pair/delete', 'POST', { number });
        toast('Pairing deleted', 'success');
        loadPairings();
    } catch (e) { toast(e.message, 'error'); }
}

// ==================== ADMIN SESSIONS (WITH ALL FUNCTIONS) ====================
async function loadAdminSessions() {
    try {
        const data = await apiCall('/api/admin/sessions/full');
        state.adminSessions = data.sessions || [];

        // Render session stats cards
        const statsEl = document.getElementById('sessionStats');
        if (statsEl) {
            const uniqueUsers = [...new Set(state.adminSessions.map(s => s.chatId))].length;
            statsEl.innerHTML = `
                <div class="session-stat">
                    <span class="session-stat-label">Total Sessions</span>
                    <span class="session-stat-value blue">${data.total || 0}</span>
                </div>
                <div class="session-stat">
                    <span class="session-stat-label">Connected</span>
                    <span class="session-stat-value green">${data.connected || 0}</span>
                </div>
                <div class="session-stat">
                    <span class="session-stat-label">Disconnected</span>
                    <span class="session-stat-value red">${data.disconnected || 0}</span>
                </div>
                <div class="session-stat">
                    <span class="session-stat-label">Users</span>
                    <span class="session-stat-value purple">${uniqueUsers}</span>
                </div>
            `;
        }

        renderAdminSessions();
        setText('badgeBotSessions', data.total || 0);
        setText('statBotSessions', data.total || 0);
    } catch (e) {
        console.error(e);
        toast(e.message, 'error');
    }
}

function renderAdminSessions() {
    const el = document.getElementById('adminSessionsList');
    if (!el) return;

    if (state.adminSessions.length === 0) {
        el.innerHTML = emptyState('No sessions', 'No WhatsApp numbers paired yet');
        return;
    }

    el.innerHTML = state.adminSessions.map(s => {
        const statusClass = s.connected ? 'connected' : 'disconnected';
        const statusText = s.connected ? 'Connected' : 'Disconnected';
        const sizeKb = (s.size / 1024).toFixed(1);
        const modDate = new Date(s.modifiedAt).toLocaleDateString();
        const modTime = new Date(s.modifiedAt).toLocaleTimeString();
        const createdDate = new Date(s.createdAt).toLocaleDateString();

        return `
            <div class="session-card ${statusClass}">
                <div class="session-head">
                    <div class="session-number">
                        <div class="session-number-main">+${s.number}</div>
                        <div class="session-number-sub">
                            <span>${escapeHtml(s.userName)}</span>
                            <span>·</span>
                            <span>ID: ${s.chatId}</span>
                        </div>
                    </div>
                    <div class="session-status ${statusClass}">
                        <span class="session-status-dot"></span>
                        <span>${statusText}</span>
                    </div>
                </div>

                <div class="session-meta">
                    <div class="session-meta-item">
                        <span class="session-meta-key">Modified</span>
                        <span class="session-meta-val">${modDate} ${modTime}</span>
                    </div>
                    <div class="session-meta-item">
                        <span class="session-meta-key">Created</span>
                        <span class="session-meta-val">${createdDate}</span>
                    </div>
                    <div class="session-meta-item">
                        <span class="session-meta-key">Size</span>
                        <span class="session-meta-val">${sizeKb} KB</span>
                    </div>
                    <div class="session-meta-item">
                        <span class="session-meta-key">Registered</span>
                        <span class="session-meta-val">${s.registered ? 'Yes' : 'No'}</span>
                    </div>
                </div>

                <div class="session-actions">
                    <button class="session-action-btn restart" onclick="restartSession('${s.chatId}', '${s.number}')">
                        Restart
                    </button>
                    <button class="session-action-btn delete" onclick="deleteSession('${s.chatId}', '${s.number}')">
                        Delete
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function restartSession(chatId, number) {
    if (!confirm(`Restart session +${number}?\n\nThe bot will reconnect this WhatsApp session.`)) return;
    try {
        const data = await apiCall('/api/admin/sessions/restart', 'POST', { chatId, number });
        toast(data.message || 'Restart signal sent', 'success');
        setTimeout(() => loadAdminSessions(), 2000);
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteSession(chatId, number) {
    if (!confirm(`Delete session +${number}?\n\nThis will disconnect WhatsApp permanently!`)) return;
    try {
        await apiCall('/api/admin/sessions/delete-full', 'POST', { chatId, number });
        toast('Session deleted', 'success');
        loadAdminSessions();
    } catch (e) { toast(e.message, 'error'); }
}

// ==================== ADMIN USERS ====================
async function loadAdminUsers() {
    try {
        const data = await apiCall('/api/admin/users');
        state.adminUsers = data.users || [];
        renderAdminUsers();
        setText('badgeUsers', state.adminUsers.length);
    } catch (e) { console.error(e); }
}

function renderAdminUsers() {
    const el = document.getElementById('adminUsersList');
    if (!el) return;
    if (state.adminUsers.length === 0) {
        el.innerHTML = emptyState('No users', '');
        return;
    }
    el.innerHTML = state.adminUsers.map(u => `
        <div class="list-item">
            <div class="list-content">
                <div class="list-title">
                    ${escapeHtml(u.username)}
                    <span class="stat-chip">${u.tier.toUpperCase()}</span>
                </div>
                <div class="list-sub">
                    Attacks: ${u.totalAttacks} · ID: ${u.id}
                </div>
            </div>
            <div class="list-actions">
                ${u.tier === 'free'
                    ? `<button class="list-btn" onclick="promptPremium('${u.id}')" title="Make Premium">Upgrade</button>`
                    : `<button class="list-btn" onclick="removePremium('${u.id}')" title="Remove Premium">Remove</button>`
                }
                <button class="list-btn danger" onclick="deleteUser('${u.id}')" title="Delete">Delete</button>
            </div>
        </div>
    `).join('');
}

async function promptPremium(userId) {
    const duration = prompt('Duration (30d, 12h, perm):', '30d');
    if (!duration) return;
    try {
        await apiCall('/api/admin/premium/add', 'POST', { userId, duration });
        toast('Premium added', 'success');
        loadAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
}

async function removePremium(userId) {
    if (!confirm('Remove premium?')) return;
    try {
        await apiCall('/api/admin/premium/remove', 'POST', { userId });
        toast('Premium removed', 'success');
        loadAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteUser(userId) {
    if (!confirm('Delete user permanently?')) return;
    try {
        await apiCall('/api/admin/user/delete', 'POST', { userId });
        toast('User deleted', 'success');
        loadAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
}

// ==================== LOGS ====================
async function loadLogs() {
    try {
        const data = await apiCall('/api/logs');
        const el = document.getElementById('logsList');
        if (!el) return;
        if (!data.logs || data.logs.length === 0) {
            el.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><div class="empty-title">No logs</div></div>';
            return;
        }
        el.innerHTML = data.logs.slice(-CONFIG.MAX_LOGS).reverse().map(line => {
            let cls = 'log-line';
            if (line.includes('[ERROR]')) cls += ' error';
            else if (line.includes('[WARN]')) cls += ' warn';
            else if (line.includes('[INFO]')) cls += ' info';
            const esc = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="${cls}">${esc}</div>`;
        }).join('');
    } catch (e) { console.error(e); }
}

// ==================== HELPERS ====================
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function showResult(el, type, text) {
    if (!el) return;
    el.className = `result show ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.textContent = text;
}

function actionValidationError(result, inputId, message) {
    showResult(result, 'error', message);
    document.getElementById(inputId)?.focus();
    toast(message, 'error');
}

function emptyState(title, text) {
    return `<div class="empty-state">
        <div class="empty-icon" aria-hidden="true"></div>
        <div class="empty-title">${title}</div>
        ${text ? `<div class="empty-text">${text}</div>` : ''}
    </div>`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.className = `toast show ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.textContent = msg;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), CONFIG.TOAST_DURATION);
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
}

// Global
window.quickAttack = quickAttack;
window.sendAttack = sendAttack;
window.requestPair = requestPair;
window.deletePairing = deletePairing;
window.restartSession = restartSession;
window.deleteSession = deleteSession;
window.promptPremium = promptPremium;
window.removePremium = removePremium;
window.deleteUser = deleteUser;
window.loadPairings = loadPairings;
window.loadAdminSessions = loadAdminSessions;
window.loadAdminUsers = loadAdminUsers;
window.loadLogs = loadLogs;
window.logout = logout;
window.toggleSidebar = toggleSidebar; 
