// ======================================
// SCANTRACK PRO - Frontend Application
// ======================================

const API_BASE = '/api';
let currentUser = null;
let currentMonth = new Date().getMonth() + 1;
let currentYear = new Date().getFullYear();

// =================== UTILITY ===================

function getToken() { return localStorage.getItem('scantrack_token'); }
function setToken(token) { localStorage.setItem('scantrack_token', token); }
function removeToken() { localStorage.removeItem('scantrack_token'); }

async function apiFetch(endpoint, options = {}) {
    const token = getToken();
    const config = {
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        ...options
    };
    const response = await fetch(`${API_BASE}${endpoint}`, config);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API Error');
    return data;
}

function $(id) { return document.getElementById(id); }
function $$(selector) { return document.querySelectorAll(selector); }

function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return Number(num).toLocaleString('en-IN');
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getRoleName(role) {
    const map = {
        super_admin: 'Super Admin',
        location_manager: 'Location Admin',
        scanner_operator: 'Scanner Operator',
        file_handler: 'File Handler'
    };
    return map[role] || role;
}

// =================== TOAST ===================

function showToast(message, type = 'success') {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
    <i class="toast-icon fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
    <span class="toast-message">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
  `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// =================== MODAL ===================

function openModal(title, bodyHTML) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHTML;
    $('modal').classList.remove('hidden');
}

function closeModal() {
    $('modal').classList.add('hidden');
}

$('modalClose')?.addEventListener('click', closeModal);
$('modal')?.addEventListener('click', (e) => {
    if (e.target === $('modal')) closeModal();
});

// =================== AUTH ===================

$('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const errorEl = $('loginError');
    const btn = $('loginBtn');

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
    errorEl.classList.add('hidden');

    try {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        setToken(data.token);
        currentUser = data.user;
        showApp();
        showToast(`Welcome back, ${currentUser.full_name}!`);
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
    }
});

function showLogin() {
    $('loginPage').classList.remove('hidden');
    $('appContainer').classList.add('hidden');
    $('loginUsername').value = '';
    $('loginPassword').value = '';
    $('loginError').classList.add('hidden');
}

async function showApp() {
    if (!getToken()) return showLogin();

    try {
        currentUser = await apiFetch('/auth/me');
    } catch (err) {
        removeToken();
        return showLogin();
    }

    $('loginPage').classList.add('hidden');
    $('appContainer').classList.remove('hidden');

    // Update user info in sidebar
    $('userName').textContent = currentUser.full_name;
    $('userRole').textContent = getRoleName(currentUser.role);
    $('userAvatar').textContent = currentUser.full_name.charAt(0).toUpperCase();

    // Show/hide nav items based on role
    setupRoleBasedUI();

    // Set current date
    $('currentDate').textContent = new Date().toLocaleDateString('en-IN', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
    });

    // Load initial data
    await loadLocationsFilter();
    navigateTo('dashboard');
}

function setupRoleBasedUI() {
    const role = currentUser.role;
    const isOperator = (role === 'scanner_operator' || role === 'file_handler');
    const isManager = (role === 'super_admin' || role === 'location_manager');

    // Admin-only elements (super_admin only)
    $$('.admin-only').forEach(el => {
        el.style.display = role === 'super_admin' ? '' : 'none';
    });

    // Manager-only elements (super_admin + location_manager)
    $$('.manager-only').forEach(el => {
        el.style.display = isManager ? '' : 'none';
    });

    // Operator-only elements (scanner_operator + file_handler)
    $$('.operator-only').forEach(el => {
        el.style.display = isOperator ? '' : 'none';
    });

    // Show location badge for location_manager
    const badge = $('locationBadge');
    if (badge) {
        if (role === 'location_manager' && currentUser.location_name) {
            badge.style.display = 'flex';
            $('locationBadgeName').textContent = currentUser.location_name;
        } else {
            badge.style.display = 'none';
        }
    }

    // Update role display with location for managers/operators
    if (currentUser.location_name && role !== 'super_admin') {
        $('userRole').textContent = `${getRoleName(role)} — ${currentUser.location_name}`;
    } else {
        $('userRole').textContent = getRoleName(role);
    }
}

$('logoutBtn')?.addEventListener('click', () => {
    removeToken();
    currentUser = null;
    showLogin();
    showToast('Logged out successfully', 'info');
});

// =================== NAVIGATION ===================

function navigateTo(page) {
    $$('.page').forEach(p => p.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));

    $(`page${capitalize(page)}`).classList.add('active');
    const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navItem) navItem.classList.add('active');

    const titles = {
        dashboard: 'Dashboard',
        tracking: 'Daily Tracking',
        locations: 'Manage Locations',
        expenses: 'Project Expenses',
        employees: 'Manage Employees',
        roles: 'Manage Roles',
        settings: 'Settings'
    };
    $('pageTitle').textContent = titles[page] || 'Dashboard';

    // Load page data
    switch (page) {
        case 'dashboard': loadDashboard(); break;
        case 'tracking': loadTracking(); break;
        case 'locations': loadLocations(); break;
        case 'expenses': loadExpenses(); break;
        case 'employees': loadEmployees(); break;
        case 'roles': loadRoles(); break;
        case 'settings': loadSettings(); break;
    }

    // Close mobile sidebar
    document.querySelector('.sidebar')?.classList.remove('open');
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

$$('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        if (page) navigateTo(page);
    });
});

// Mobile sidebar
$('mobileSidebarToggle')?.addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('open');
});

// =================== LOAD LOCATIONS FILTER ===================

async function loadLocationsFilter() {
    if (currentUser.role !== 'super_admin') return;

    try {
        const locations = await apiFetch('/locations');
        const sel1 = $('globalLocationFilter');
        const sel2 = $('employeeLocationFilter');

        [sel1, sel2].forEach(sel => {
            if (!sel) return;
            sel.innerHTML = '<option value="">All Locations</option>';
            locations.forEach(loc => {
                sel.innerHTML += `<option value="${loc.id}">${loc.name}</option>`;
            });
        });

        sel1?.addEventListener('change', () => {
            const activePage = document.querySelector('.page.active')?.id?.replace('page', '').toLowerCase();
            if (activePage) navigateTo(activePage);
        });
    } catch (err) {
        console.error('Failed to load locations filter', err);
    }
}

function getSelectedLocation() {
    if (currentUser.role === 'super_admin') {
        return $('globalLocationFilter')?.value || '';
    }
    return currentUser.location_id || '';
}

// =================== DASHBOARD ===================

async function loadDashboard() {
    try {
        const role = currentUser.role;
        const isOperator = (role === 'scanner_operator' || role === 'file_handler');

        // OPERATOR VIEW - show simple personal dashboard
        if (isOperator) {
            $('operatorDashboard').style.display = 'block';
            $('adminDashboard').style.display = 'none';
            await loadOperatorDashboard();
            return;
        }

        // ADMIN/MANAGER VIEW
        $('operatorDashboard').style.display = 'none';
        $('adminDashboard').style.display = 'block';

        // Load location filter (super_admin only)
        if (role === 'super_admin') {
            await loadDashboardLocationFilter();
        }

        // Get location filter - super_admin can filter, location_manager uses their own location
        let params = '';
        if (role === 'super_admin') {
            const filterLocId = $('dashboardLocationFilter')?.value || '';
            params = filterLocId ? `?location_id=${filterLocId}` : '';
        } else if (role === 'location_manager') {
            params = `?location_id=${currentUser.location_id}`;
        }

        const data = await apiFetch(`/dashboard/simple${params}`);
        const { locations, totals } = data;

        // Update summary cards
        $('totalScansAll').textContent = formatNumber(totals.total_scans);
        $('totalRevenueAll').textContent = '₹' + formatNumber(totals.total_revenue);
        $('totalLabourAll').textContent = '₹' + formatNumber(totals.total_employee_cost);
        $('totalExpensesAll').textContent = '₹' + formatNumber(totals.total_expenses);

        // Update location table
        const tbody = $('locationSummaryBody');
        const tfoot = $('locationSummaryFoot');

        const isAdmin = currentUser.role === 'super_admin';
        const colSpan = isAdmin ? 6 : 5;

        if (locations.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:10px;"></i>No locations added yet</td></tr>`;
            tfoot.innerHTML = '';
        } else {
            tbody.innerHTML = locations.map(loc => `
                <tr class="location-row" data-location-id="${loc.location_id}" style="cursor: pointer;">
                    <td><strong>${loc.location_name}</strong> <i class="fas fa-chevron-right" style="font-size:10px;color:var(--text-muted);margin-left:5px;"></i></td>
                    <td>₹${loc.client_rate}</td>
                    <td>${formatNumber(loc.total_scans)}</td>
                    <td style="color: #f59e0b;">₹${formatNumber(loc.employee_cost)}</td>
                    ${isAdmin ? `<td style="color: #ef4444;">₹${formatNumber(loc.expenses)}</td>` : ''}
                    <td style="color: #22c55e; font-weight: 600;">₹${formatNumber(loc.revenue)}</td>
                </tr>
            `).join('');

            tfoot.innerHTML = `
                <tr>
                    <td>TOTAL</td>
                    <td></td>
                    <td>${formatNumber(totals.total_scans)}</td>
                    <td style="color: #f59e0b;">₹${formatNumber(totals.total_employee_cost)}</td>
                    ${isAdmin ? `<td style="color: #ef4444;">₹${formatNumber(totals.total_expenses)}</td>` : ''}
                    <td style="color: #22c55e;">₹${formatNumber(totals.total_revenue)}</td>
                </tr>
            `;

            // Add click handlers for location rows
            tbody.querySelectorAll('.location-row').forEach(row => {
                row.addEventListener('click', () => {
                    const locId = row.dataset.locationId;
                    showLocationDetail(locId);
                });
            });
        }

        // Hide location detail panel when loading fresh
        $('locationDetailPanel').style.display = 'none';

    } catch (err) {
        showToast('Failed to load dashboard: ' + err.message, 'error');
    }
}

// Load operator dashboard (for scanner_operator and file_handler)
async function loadOperatorDashboard() {
    try {
        // Get operator's own records
        const today = getTodayStr();
        const records = await apiFetch(`/records?user_id=${currentUser.id}`);

        // Calculate totals
        let totalScans = 0;
        let todayScans = 0;

        records.forEach(r => {
            if (r.status === 'present' && r.scan_count) {
                totalScans += r.scan_count;
                if (r.record_date === today) {
                    todayScans = r.scan_count;
                }
            }
        });

        $('myTotalScans').textContent = formatNumber(totalScans);
        $('myTodayScans').textContent = formatNumber(todayScans);

    } catch (err) {
        showToast('Failed to load your data: ' + err.message, 'error');
    }
}

// Operator Add Scan button
$('operatorAddScanBtn')?.addEventListener('click', () => {
    const today = getTodayStr();
    const formattedDate = formatDate(today);

    openModal(`Add My Scan Count - ${formattedDate}`, `
        <form id="operatorScanForm">
            <div class="form-group">
                <label><i class="fas fa-file-alt"></i> Number of Scans</label>
                <input type="number" id="opScanCount" placeholder="Enter your scan count" min="0" required autofocus style="font-size: 24px; text-align: center; padding: 20px;">
            </div>
            <div class="form-group">
                <label><i class="fas fa-sticky-note"></i> Notes (optional)</label>
                <input type="text" id="opScanNotes" placeholder="Any notes...">
            </div>
            <button type="submit" class="btn btn-primary btn-full btn-lg">
                <i class="fas fa-save"></i> Save My Scan Count
            </button>
        </form>
    `);

    $('operatorScanForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const scanCount = parseInt($('opScanCount').value) || 0;
        const notes = $('opScanNotes').value;

        try {
            await apiFetch('/records', {
                method: 'POST',
                body: JSON.stringify({
                    user_id: currentUser.id,
                    record_date: today,
                    scan_count: scanCount,
                    status: 'present',
                    notes
                })
            });
            showToast('Scan count saved successfully!');
            closeModal();
            loadOperatorDashboard();
        } catch (err) {
            showToast('Failed to save: ' + err.message, 'error');
        }
    });
});

// Load dashboard location filter
async function loadDashboardLocationFilter() {
    const select = $('dashboardLocationFilter');
    if (!select || select.options.length > 1) return; // Already loaded

    try {
        const locations = await apiFetch('/locations');
        select.innerHTML = '<option value="">All Locations</option>';
        locations.forEach(loc => {
            select.innerHTML += `<option value="${loc.id}">${loc.name}</option>`;
        });
    } catch (e) {
        console.error('Failed to load locations for filter', e);
    }
}

// Show location detail panel
async function showLocationDetail(locationId) {
    try {
        const data = await apiFetch(`/dashboard/location/${locationId}`);
        const { location, employees, summary } = data;

        // Update header
        $('locationDetailName').textContent = location.name;

        // Update summary cards
        $('locDetailScans').textContent = formatNumber(summary.total_scans);
        $('locDetailRevenue').textContent = '₹' + formatNumber(summary.revenue);
        $('locDetailCost').textContent = '₹' + formatNumber(summary.employee_cost);
        $('locDetailExpenses').textContent = '₹' + formatNumber(summary.expenses);

        // Update employees table
        const tbody = $('locDetailEmployees');
        if (employees.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted);">No employees</td></tr>';
        } else {
            tbody.innerHTML = employees.map(emp => `
                <tr>
                    <td><strong>${emp.full_name}</strong></td>
                    <td>${getRoleName(emp.role)}</td>
                    <td>${formatNumber(emp.total_scans)}</td>
                    <td style="color: #f59e0b;">₹${formatNumber(emp.earnings)}</td>
                </tr>
            `).join('');
        }

        // Show panel
        $('locationDetailPanel').style.display = 'block';
        $('locationDetailPanel').scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
        showToast('Failed to load location details: ' + err.message, 'error');
    }
}

// Close location detail panel
$('closeLocationDetail')?.addEventListener('click', () => {
    $('locationDetailPanel').style.display = 'none';
});

// Dashboard location filter change
$('dashboardLocationFilter')?.addEventListener('change', () => {
    loadDashboard();
});

function renderTrendChart(trend) {
    const container = $('trendChart');
    if (!trend || trend.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-chart-line"></i><p>No data yet</p></div>';
        return;
    }

    const maxVal = Math.max(...trend.map(t => t.total), 1);
    container.innerHTML = trend.map(t => {
        const height = Math.max((t.total / maxVal) * 160, 4);
        const date = new Date(t.record_date);
        const label = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        return `
      <div class="chart-bar-group">
        <div class="chart-bar" style="height: ${height}px">
          <span class="chart-bar-value">${formatNumber(t.total)}</span>
        </div>
        <span class="chart-bar-label">${label}</span>
      </div>
    `;
    }).join('');
}

function renderTopPerformers(performers) {
    const container = $('topPerformers');
    if (!performers || performers.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-trophy"></i><p>No data yet</p></div>';
        return;
    }

    container.innerHTML = performers.map((p, i) => {
        const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'normal';
        return `
      <div class="performer-item">
        <div class="performer-rank ${rankClass}">${i + 1}</div>
        <div class="performer-info">
          <div class="performer-name">${p.full_name}</div>
          <div class="performer-scanner">${p.scanner_id || 'N/A'} · ${p.days_present} days</div>
        </div>
        <div class="performer-count">${formatNumber(p.total_scans)}</div>
      </div>
    `;
    }).join('');
}

// =================== DAILY TRACKING ===================

function updateMonthLabel() {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    $('currentMonthLabel').textContent = `${months[currentMonth - 1]} ${currentYear}`;
}

$('prevMonth')?.addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    updateMonthLabel();
    loadTracking();
});

$('nextMonth')?.addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    updateMonthLabel();
    loadTracking();
});

async function loadTracking() {
    updateMonthLabel();
    const locationId = getSelectedLocation();
    let params = `?month=${currentMonth}&year=${currentYear}`;
    if (locationId) params += `&location_id=${locationId}`;

    try {
        const data = await apiFetch(`/records/monthly${params}`);
        renderTrackingTable(data);
    } catch (err) {
        showToast('Failed to load tracking data: ' + err.message, 'error');
    }
}

function renderTrackingTable(data) {
    const { dates, users } = data;
    const thead = $('trackingHead');
    const tbody = $('trackingBody');

    // Header row 1: Day names
    // Columns: Name, Scanner, ...Dates..., Total, Earnings
    let headerRow1 = '<tr><th>Employee</th><th>Scanner</th>';
    data.dates.forEach(d => {
        const isSun = d.dayName === 'Sun';
        headerRow1 += `<th class="${isSun ? 'day-sun' : ''}">${d.dayName}<br>${d.day}</th>`;
    });
    headerRow1 += '<th>Total</th><th>Earnings (₹)</th></tr>';
    thead.innerHTML = headerRow1;

    if (data.users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${data.dates.length + 4}" style="text-align:center;padding:40px;color:var(--text-muted);">
      <i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:12px;"></i>No employees found. Add employees first.</td></tr>`;
        return;
    }

    // Group by role
    const scanners = data.users.filter(u => u.role === 'scanner_operator');
    const handlers = data.users.filter(u => u.role === 'file_handler');
    const managers = data.users.filter(u => u.role === 'location_manager');
    const allGroups = [];
    let grandEarnings = 0;

    if (scanners.length) allGroups.push({ label: '📠 Scanner Operators', users: scanners });
    if (handlers.length) allGroups.push({ label: '📁 File Handlers', users: handlers });
    if (managers.length) allGroups.push({ label: '👔 Managers', users: managers });

    let bodyHTML = '';
    const dailyTotals = {};
    dates.forEach(d => dailyTotals[d.date] = 0);

    allGroups.forEach(group => {
        bodyHTML += `<tr class="group-separator"><td colspan="${data.dates.length + 4}">${group.label}</td></tr>`;

        group.users.forEach(user => {
            let userTotal = 0;
            bodyHTML += `<tr>`;
            bodyHTML += `<td>${user.full_name}</td>`;
            bodyHTML += `<td>${user.scanner_id || '—'}</td>`;

            dates.forEach(d => {
                const record = user.daily[d.date];
                const isSun = d.dayName === 'Sun';
                const isClickable = canEditRecords() ? 'cell-clickable' : '';

                if (!record) {
                    if (isSun) {
                        bodyHTML += `<td class="cell-holiday day-sun ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">—</td>`;
                    } else {
                        bodyHTML += `<td class="cell-empty ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">·</td>`;
                    }
                } else if (record.status === 'absent') {
                    bodyHTML += `<td class="cell-absent ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">AB</td>`;
                } else if (record.status === 'file_close') {
                    bodyHTML += `<td class="cell-fileclose ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">File Close</td>`;
                } else if (record.status === 'holiday') {
                    bodyHTML += `<td class="cell-holiday ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">Holiday</td>`;
                } else {
                    const count = record.scan_count || 0;
                    userTotal += count;
                    dailyTotals[d.date] = (dailyTotals[d.date] || 0) + count;
                    bodyHTML += `<td class="cell-present ${isClickable}" data-user="${user.user_id}" data-date="${d.date}">${formatNumber(count)}</td>`;
                }
            });

            // Total Column
            bodyHTML += `<td style="font-weight:700;color:var(--primary-light);">${formatNumber(userTotal)}</td>`;

            // Earnings Column
            let earnings = 0;
            if (user.salary_type === 'fixed') {
                const daysInMonth = new Date(data.year, data.month, 0).getDate();
                const dailyRate = (user.fixed_salary || 0) / daysInMonth;
                let presentDays = 0;
                // Count days present from daily records
                data.dates.forEach(d => {
                    const r = user.daily[d.date];
                    if (r && r.status === 'present') presentDays++;
                });
                earnings = Math.round(dailyRate * presentDays);
            } else {
                const rate = user.custom_rate || data.scan_rate || 0.10;
                earnings = Math.round(userTotal * rate);
            }

            grandEarnings += earnings;
            bodyHTML += `<td><strong>₹${formatNumber(earnings)}</strong>${user.salary_type === 'fixed' ? ' <small class="text-muted">(Fix)</small>' : ''}</td>`;

            bodyHTML += `</tr>`;
        });
    });

    // Total row
    let grandTotal = 0;
    // grandEarnings already calculated above

    bodyHTML += '<tr class="total-row"><td>TOTAL</td><td></td>';
    data.dates.forEach(d => {
        const val = dailyTotals[d.date] || 0;
        grandTotal += val;
        bodyHTML += `<td>${val ? formatNumber(val) : '—'}</td>`;
    });
    bodyHTML += `<td>${formatNumber(grandTotal)}</td>`;
    bodyHTML += `<td>₹${formatNumber(grandEarnings)}</td></tr>`;

    tbody.innerHTML = bodyHTML;

    // Add click handlers for editable cells
    if (canEditRecords()) {
        tbody.querySelectorAll('.cell-clickable').forEach(cell => {
            cell.addEventListener('click', () => {
                const userId = cell.dataset.user;
                const date = cell.dataset.date;
                const userName = users.find(u => u.user_id == userId)?.full_name || '';
                openRecordModal(userId, date, userName);
            });
        });
    }
}

function canEditRecords() {
    return currentUser && ['super_admin', 'location_manager', 'scanner_operator', 'file_handler'].includes(currentUser.role);
}

function openRecordModal(userId, date, userName) {
    // For operators, they can only edit their own
    if ((currentUser.role === 'scanner_operator' || currentUser.role === 'file_handler') && userId != currentUser.id) return;

    const formattedDate = formatDate(date);
    openModal(`Record: ${userName} — ${formattedDate}`, `
    <form id="recordForm">
      <div class="form-group">
        <label><i class="fas fa-clipboard-check"></i> Status</label>
        <select id="recordStatus" class="form-select" >
          <option value="present">Present (with scan count)</option>
          <option value="absent">Absent</option>
          <option value="file_close">File Close</option>
          <option value="holiday">Holiday</option>
        </select>
      </div>
      <div class="form-group" id="scanCountGroup">
        <label><i class="fas fa-file-alt"></i> Scan Count</label>
        <input type="number" id="recordScanCount" placeholder="Enter number of scans" min="0">
      </div>
      <div class="form-group">
        <label><i class="fas fa-sticky-note"></i> Notes (optional)</label>
        <input type="text" id="recordNotes" placeholder="Any notes...">
      </div>
      <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-save"></i> Save Record</button>
    </form>
  `);

    // Toggle scan count visibility
    $('recordStatus').addEventListener('change', (e) => {
        $('scanCountGroup').style.display = e.target.value === 'present' ? '' : 'none';
    });

    $('recordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = $('recordStatus').value;
        const scan_count = status === 'present' ? parseInt($('recordScanCount').value) || 0 : null;
        const notes = $('recordNotes').value;

        try {
            await apiFetch('/records', {
                method: 'POST',
                body: JSON.stringify({ user_id: userId, record_date: date, scan_count, status, notes })
            });
            showToast('Record saved successfully!');
            closeModal();
            loadTracking();
        } catch (err) {
            showToast('Failed to save: ' + err.message, 'error');
        }
    });
}

// =================== BULK ENTRY ===================

let bulkEntryUsers = [];

// Format a Date object as YYYY-MM-DD using LOCAL timezone (not UTC)
function formatLocalDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getTodayStr() {
    return formatLocalDate(new Date());
}

function getBulkDate() {
    return $('bulkDate').value;
}

function setBulkDate(dateStr) {
    $('bulkDate').value = dateStr;
    updateBulkDateLabel(dateStr);
    loadBulkEntryForm(dateStr);
}

function updateBulkDateLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const today = getTodayStr();
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const yesterday = formatLocalDate(yd);

    let label = d.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
    if (dateStr === today) label += ' (Today)';
    else if (dateStr === yesterday) label += ' (Yesterday)';

    $('bulkDateLabel').textContent = label;
}

$('bulkEntryBtn')?.addEventListener('click', async () => {
    const panel = $('bulkEntryPanel');
    const tableView = $('trackingTableView');

    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        tableView.style.display = '';
        return;
    }

    const today = getTodayStr();
    $('bulkDate').max = today; // Set max date to today
    $('bulkDate').value = today;
    updateBulkDateLabel(today);

    await loadBulkEntryForm(today);

    panel.classList.remove('hidden');
    tableView.style.display = 'none';
});

$('bulkEntryClose')?.addEventListener('click', () => {
    $('bulkEntryPanel').classList.add('hidden');
    $('trackingTableView').style.display = '';
});

// Date change handler
$('bulkDate')?.addEventListener('change', async (e) => {
    const selected = e.target.value;
    const today = getTodayStr();
    if (selected > today) {
        showToast("Future dates are not allowed", "error");
        setBulkDate(today);
        return;
    }
    updateBulkDateLabel(selected);
    await loadBulkEntryForm(selected);
});

// Previous day
$('bulkDatePrev')?.addEventListener('click', () => {
    const current = new Date(getBulkDate() + 'T12:00:00');
    current.setDate(current.getDate() - 1);
    setBulkDate(formatLocalDate(current));
});

// Next day
$('bulkDateNext')?.addEventListener('click', () => {
    const current = new Date(getBulkDate() + 'T12:00:00');
    current.setDate(current.getDate() + 1);
    const nextDate = formatLocalDate(current);
    const today = getTodayStr();

    if (nextDate > today) {
        showToast("Cannot navigate to future date", "error");
        return;
    }
    setBulkDate(nextDate);
});

// Today shortcut
$('bulkDateToday')?.addEventListener('click', () => {
    setBulkDate(getTodayStr());
});

// Yesterday shortcut
$('bulkDateYesterday')?.addEventListener('click', () => {
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    setBulkDate(formatLocalDate(yd));
});

async function loadBulkEntryForm(date) {
    const locationId = getSelectedLocation();
    let locParam = locationId ? `?location_id=${locationId}` : '';

    try {
        const users = await apiFetch(`/users${locParam}`);
        bulkEntryUsers = users.filter(u => u.role !== 'super_admin');

        // Fetch existing records for this date
        const dateObj = new Date(date + 'T00:00:00');
        const month = dateObj.getMonth() + 1;
        const year = dateObj.getFullYear();
        let params = `?month=${month}&year=${year}`;
        if (locationId) params += `&location_id=${locationId}`;
        const trackingData = await apiFetch(`/records/monthly${params}`);

        const existingRecords = {};
        trackingData.users.forEach(u => {
            if (u.daily[date]) {
                existingRecords[u.user_id] = u.daily[date];
            }
        });

        renderBulkEntryTable(bulkEntryUsers, existingRecords);
    } catch (err) {
        showToast('Failed to load employees: ' + err.message, 'error');
    }
}

function renderBulkEntryTable(users, existingRecords) {
    const tbody = $('bulkEntryBody');

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-muted);">
            <i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:12px;"></i>
            No employees found. Add employees first.</td></tr>`;
        updateBulkSummary();
        return;
    }

    // Group by role
    const scanners = users.filter(u => u.role === 'scanner_operator');
    const handlers = users.filter(u => u.role === 'file_handler');
    const managers = users.filter(u => u.role === 'location_manager');
    const allGroups = [];

    if (scanners.length) allGroups.push({ label: '📠 Scanner Operators', users: scanners });
    if (handlers.length) allGroups.push({ label: '📁 File Handlers', users: handlers });
    if (managers.length) allGroups.push({ label: '👔 Managers', users: managers });

    let html = '';
    let sno = 0;

    allGroups.forEach(group => {
        html += `<tr class="be-group-sep"><td colspan="5">${group.label}</td></tr>`;

        group.users.forEach(user => {
            sno++;
            const existing = existingRecords[user.id] || {};
            const status = existing.status || 'present';
            const scanCount = existing.scan_count != null ? existing.scan_count : '';
            const notes = existing.notes || '';
            const isPresent = status === 'present';
            const scannerInfo = user.scanner_id ? `<span class="be-scanner-tag">${user.scanner_id}</span>` : '';

            html += `
                <tr class="be-row ${!isPresent ? 'be-row-absent' : ''}" data-user-id="${user.id}">
                    <td class="be-sno">${sno}</td>
                    <td class="be-name-cell">
                        <div class="be-name">${user.full_name}</div>
                        ${scannerInfo}
                    </td>
                    <td>
                        <input type="number" class="be-scan-input" data-user-id="${user.id}"
                            placeholder="Enter scans" min="0" value="${isPresent ? scanCount : ''}"
                            ${!isPresent ? 'disabled' : ''}>
                    </td>
                    <td>
                        <select class="be-status-select" data-user-id="${user.id}">
                            <option value="present" ${status === 'present' ? 'selected' : ''}>✅ Present</option>
                            <option value="absent" ${status === 'absent' ? 'selected' : ''}>❌ Absent</option>
                            <option value="file_close" ${status === 'file_close' ? 'selected' : ''}>📁 File Close</option>
                            <option value="holiday" ${status === 'holiday' ? 'selected' : ''}>🏖️ Holiday</option>
                        </select>
                    </td>
                    <td>
                        <input type="text" class="be-notes-input" data-user-id="${user.id}"
                            placeholder="Notes..." value="${notes}">
                    </td>
                </tr>
            `;
        });
    });

    tbody.innerHTML = html;

    // Status change listeners
    tbody.querySelectorAll('.be-status-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
            const userId = e.target.dataset.userId;
            const row = tbody.querySelector(`tr[data-user-id="${userId}"]`);
            const scanInput = tbody.querySelector(`.be-scan-input[data-user-id="${userId}"]`);

            if (e.target.value === 'present') {
                row.classList.remove('be-row-absent');
                scanInput.disabled = false;
                scanInput.focus();
            } else {
                row.classList.add('be-row-absent');
                scanInput.disabled = true;
                scanInput.value = '';
            }
            updateBulkSummary();
        });
    });

    // Live summary update
    tbody.querySelectorAll('.be-scan-input').forEach(input => {
        input.addEventListener('input', updateBulkSummary);
    });

    $('bulkTotalEmployees').textContent = users.length;
    updateBulkSummary();
}

function updateBulkSummary() {
    const tbody = $('bulkEntryBody');
    const statusSelects = tbody.querySelectorAll('.be-status-select');
    const scanInputs = tbody.querySelectorAll('.be-scan-input');

    let presentCount = 0;
    let totalScans = 0;

    statusSelects.forEach(sel => {
        if (sel.value === 'present') presentCount++;
    });

    scanInputs.forEach(input => {
        if (!input.disabled) {
            totalScans += parseInt(input.value) || 0;
        }
    });

    $('bulkPresentCount').textContent = presentCount;
    $('bulkTotalScans').textContent = formatNumber(totalScans);
}

// Save All Records
$('bulkSaveBtn')?.addEventListener('click', async () => {
    const date = $('bulkDate').value;
    if (!date) {
        showToast('Please select a date', 'error');
        return;
    }

    const tbody = $('bulkEntryBody');
    const records = [];

    bulkEntryUsers.forEach(user => {
        const statusSel = tbody.querySelector(`.be-status-select[data-user-id="${user.id}"]`);
        const scanInput = tbody.querySelector(`.be-scan-input[data-user-id="${user.id}"]`);
        const notesInput = tbody.querySelector(`.be-notes-input[data-user-id="${user.id}"]`);

        if (!statusSel) return;

        const status = statusSel.value;
        const scan_count = status === 'present' ? (parseInt(scanInput.value) || 0) : null;
        const notes = notesInput.value.trim();

        records.push({
            user_id: user.id,
            record_date: date,
            scan_count,
            status,
            notes: notes || null
        });
    });

    if (records.length === 0) {
        showToast('No records to save', 'error');
        return;
    }

    const btn = $('bulkSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    try {
        await apiFetch('/records/bulk', {
            method: 'POST',
            body: JSON.stringify({ records })
        });
        showToast(`✅ ${records.length} records saved successfully!`);

        // Close bulk entry and refresh tracking table
        $('bulkEntryPanel').classList.add('hidden');
        $('trackingTableView').style.display = '';
        loadTracking();
    } catch (err) {
        showToast('Failed to save: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> Save All Records';
    }
});

// Single Entry (old Add Record) button
$('addRecordBtn')?.addEventListener('click', async () => {
    const locationId = getSelectedLocation();
    let locParam = locationId ? `?location_id=${locationId}` : '';

    try {
        const users = await apiFetch(`/users${locParam}`);
        const today = getTodayStr();

        openModal('Add Single Record', `
      <form id="quickRecordForm">
        <div class="form-group">
          <label><i class="fas fa-user"></i> Employee</label>
          <select id="qrUser" class="form-select"  required>
            <option value="">Select Employee</option>
            ${users.map(u => `<option value="${u.id}">${u.full_name} (${getRoleName(u.role)})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label><i class="fas fa-calendar"></i> Date</label>
          <input type="date" id="qrDate" value="${today}" max="${today}" required>
        </div>
        <div class="form-group">
          <label><i class="fas fa-clipboard-check"></i> Status</label>
          <select id="qrStatus" class="form-select" >
            <option value="present">Present</option>
            <option value="absent">Absent</option>
            <option value="file_close">File Close</option>
            <option value="holiday">Holiday</option>
          </select>
        </div>
        <div class="form-group" id="qrScanGroup">
          <label><i class="fas fa-file-alt"></i> Scan Count</label>
          <input type="number" id="qrScanCount" placeholder="Number of scans" min="0">
        </div>
        <div class="form-group">
          <label><i class="fas fa-sticky-note"></i> Notes</label>
          <input type="text" id="qrNotes" placeholder="Optional notes">
        </div>
        <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-save"></i> Save Record</button>
      </form>
    `);

        $('qrStatus').addEventListener('change', (e) => {
            $('qrScanGroup').style.display = e.target.value === 'present' ? '' : 'none';
        });

        $('quickRecordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const status = $('qrStatus').value;
            try {
                await apiFetch('/records', {
                    method: 'POST',
                    body: JSON.stringify({
                        user_id: $('qrUser').value,
                        record_date: $('qrDate').value,
                        scan_count: status === 'present' ? parseInt($('qrScanCount').value) || 0 : null,
                        status,
                        notes: $('qrNotes').value
                    })
                });
                showToast('Record added!');
                closeModal();
                loadTracking();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    } catch (err) {
        showToast('Failed to load employees', 'error');
    }
});

// =================== LOCATIONS ===================

async function loadLocations() {
    try {
        const locations = await apiFetch('/locations');
        const container = $('locationsList');

        if (locations.length === 0) {
            container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
        <i class="fas fa-map-marker-alt"></i><p>No locations yet. Click "Add Location" to create one.</p></div>`;
            return;
        }

        container.innerHTML = locations.map(loc => `
      <div class="location-card">
        <div class="location-card-header">
          <div>
            <h4>${loc.name}</h4>
            <div class="location-address"><i class="fas fa-map-pin"></i> ${loc.address || 'No address'}</div>
          </div>
          <div class="location-card-actions">
            <button class="action-btn" onclick="editLocation(${loc.id}, '${loc.name}', '${loc.address || ''}', ${loc.client_rate || 0}, ${loc.is_active})"><i class="fas fa-edit"></i></button>
            <button class="action-btn delete" onclick="deleteLocation(${loc.id}, '${loc.name}')"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <div class="location-card-stats">
          <div class="location-stat">
            <span class="location-stat-value">${loc.employee_count}</span>
            <span class="location-stat-label">Employees</span>
          </div>
          <div class="location-stat">
            <span class="location-stat-value">₹${loc.client_rate || 0}</span>
            <span class="location-stat-label">Client Rate</span>
          </div>
          <div class="location-stat">
            <span class="location-stat-value">${loc.is_active ? '✅' : '❌'}</span>
            <span class="location-stat-label">Status</span>
          </div>
        </div>
      </div>
    `).join('');
    } catch (err) {
        showToast('Failed to load locations: ' + err.message, 'error');
    }
}

$('addLocationBtn')?.addEventListener('click', () => {
    openModal('Add New Location', `
    <form id="locationForm">
      <div class="form-group">
        <label><i class="fas fa-building"></i> Location Name</label>
        <input type="text" id="locName" placeholder="e.g. PALWAL" required>
      </div>
      <div class="form-group">
        <label><i class="fas fa-map-pin"></i> Address</label>
        <input type="text" id="locAddress" placeholder="Full address (optional)">
      </div>
      <div class="form-group">
        <label><i class="fas fa-rupee-sign"></i> Client Rate (per page)</label>
        <input type="number" id="locRate" step="0.01" placeholder="0.00">
      </div>
      <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-plus"></i> Create Location</button>
    </form>
  `);

    $('locationForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch('/locations', {
                method: 'POST',
                body: JSON.stringify({
                    name: $('locName').value,
                    address: $('locAddress').value,
                    client_rate: $('locRate').value
                })
            });
            showToast('Location created!');
            closeModal();
            loadLocations();
            loadLocationsFilter();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
});

window.editLocation = function (id, name, address, rate, active) {
    openModal('Edit Location', `
    <form id="editLocForm">
      <div class="form-group">
        <label><i class="fas fa-building"></i> Location Name</label>
        <input type="text" id="editLocName" value="${name}" required>
      </div>
      <div class="form-group">
        <label><i class="fas fa-map-pin"></i> Address</label>
        <input type="text" id="editLocAddress" value="${address}">
      </div>
      <div class="form-group">
        <label><i class="fas fa-rupee-sign"></i> Client Rate (per page)</label>
        <input type="number" id="editLocRate" step="0.01" value="${rate}">
      </div>
      <div style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;">
          <label style="display:flex;align-items:center;cursor:pointer;">
              <input type="checkbox" id="editLocActive" style="margin-right:8px;transform:scale(1.2);" ${active ? 'checked' : ''}>
              <span>Is Active</span>
          </label>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Update Location</button>
      </div>
    </form>
  `);

    $('editLocForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch(`/locations/${id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name: $('editLocName').value,
                    address: $('editLocAddress').value,
                    client_rate: $('editLocRate').value,
                    is_active: $('editLocActive').checked ? 1 : 0
                })
            });
            showToast('Location updated!');
            closeModal();
            loadLocations();
            loadLocationsFilter();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
};

window.deleteLocation = async function (id, name) {
    if (!confirm(`Are you sure you want to deactivate "${name}"?`)) return;
    try {
        await apiFetch(`/locations/${id}`, { method: 'DELETE' });
        showToast('Location deactivated');
        loadLocations();
        loadLocationsFilter();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

// =================== EMPLOYEES ===================

let usersCache = [];

async function loadEmployees() {
    const locationId = getSelectedLocation();
    const roleFilter = $('employeeRoleFilter')?.value || '';
    let params = '?';
    if (locationId) params += `location_id=${locationId}&`;
    if (roleFilter) params += `role=${roleFilter}&`;

    try {
        usersCache = await apiFetch(`/users${params}`);
        const users = usersCache;
        const tbody = $('employeesList');

        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">
        <i class="fas fa-users" style="font-size:32px;display:block;margin-bottom:12px;"></i>No employees found</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${u.full_name}</strong></td>
        <td style="color:var(--text-muted)">${u.username}</td>
        <td><span class="role-badge ${u.role}">${getRoleName(u.role)}</span></td>
        <td>${u.location_name || '—'}</td>
        <td style="color:var(--accent)">${u.scanner_id || '—'}</td>
        <td>
          <div class="action-btns">
            <button class="action-btn" onclick="editEmployee(${u.id})"><i class="fas fa-edit"></i></button>
            <button class="action-btn delete" onclick="deleteEmployee(${u.id}, '${u.full_name}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `).join('');
    } catch (err) {
        showToast('Failed to load employees: ' + err.message, 'error');
    }
}

$('employeeRoleFilter')?.addEventListener('change', loadEmployees);
$('employeeLocationFilter')?.addEventListener('change', loadEmployees);

$('addEmployeeBtn')?.addEventListener('click', async () => {
    let locationsHTML = '';
    if (currentUser.role === 'super_admin') {
        try {
            const locations = await apiFetch('/locations');
            locationsHTML = `
        <div class="form-group">
          <label><i class="fas fa-map-marker-alt"></i> Location</label>
          <select id="empLocation" class="form-select" required>
            <option value="">Select Location</option>
            ${locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('')}
          </select>
        </div>
      `;
        } catch (e) { }
    } else if (currentUser.role === 'location_manager') {
        // Show location info (read-only) for location manager
        locationsHTML = `
        <div class="form-group">
          <label><i class="fas fa-map-marker-alt"></i> Location</label>
          <div style="padding: 12px 16px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px; color: var(--primary-light); font-weight: 600;">
            <i class="fas fa-building" style="margin-right: 8px;"></i>${currentUser.location_name}
          </div>
        </div>
      `;
    }

    openModal('Add New Employee', `
    <form id="employeeForm">
      <div class="form-row">
        <div class="form-group">
          <label><i class="fas fa-user"></i> Full Name</label>
          <input type="text" id="empName" placeholder="Employee name" required>
        </div>
        <div class="form-group">
          <label><i class="fas fa-at"></i> Username</label>
          <input type="text" id="empUsername" placeholder="Login username" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label><i class="fas fa-lock"></i> Password</label>
          <input type="password" id="empPassword" placeholder="Login password" required>
        </div>
        <div class="form-group">
          <label><i class="fas fa-user-tag"></i> Role</label>
          <select id="empRole" class="form-select" >
            <option value="scanner_operator">Scanner Operator</option>
            <option value="file_handler">File Handler</option>
            ${currentUser.role === 'super_admin' ? '<option value="location_manager">Location Admin</option>' : ''}
          </select>
        </div>
      </div>
      </div>
      ${locationsHTML}
      <div class="form-group">
        <label><i class="fas fa-barcode"></i> Scanner ID (optional)</label>
        <input type="text" id="empScanner" placeholder="e.g. Kodak i3400, fi-7180">
      </div>
      
      <!-- Salary Section -->
      <div class="form-row">
          <div class="form-group">
            <label><i class="fas fa-money-check-alt"></i> Salary Type</label>
            <select id="empSalaryType" class="form-select" >
                <option value="per_page">Per Page Rate</option>
                <option value="fixed">Fixed Salary</option>
            </select>
          </div>
          <div class="form-group" id="empRateGroup">
            <label><i class="fas fa-rupee-sign"></i> Per Page Rate</label>
            <input type="number" id="empCustomRate" step="0.01" placeholder="Default (Global Rate)">
          </div>
          <div class="form-group" id="empFixedGroup" style="display:none;">
            <label><i class="fas fa-rupee-sign"></i> Monthly Salary</label>
            <input type="number" id="empFixedSalary" placeholder="e.g. 15000">
          </div>
      </div>

      <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-plus"></i> Create Employee</button>
    </form>
  `);

    $('empSalaryType').addEventListener('change', (e) => {
        if (e.target.value === 'fixed') {
            $('empRateGroup').style.display = 'none';
            $('empFixedGroup').style.display = 'block';
        } else {
            $('empRateGroup').style.display = 'block';
            $('empFixedGroup').style.display = 'none';
        }
    });

    $('employeeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch('/users', {
                method: 'POST',
                body: JSON.stringify({
                    full_name: $('empName').value,
                    username: $('empUsername').value,
                    password: $('empPassword').value,
                    role: $('empRole').value,
                    location_id: $('empLocation')?.value || currentUser.location_id,
                    scanner_id: $('empScanner').value,
                    salary_type: $('empSalaryType').value,
                    custom_rate: $('empCustomRate').value || null,
                    fixed_salary: $('empFixedSalary').value || null
                })
            });
            showToast('Employee created!');
            closeModal();
            loadEmployees();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
});

window.editEmployee = function (id) {
    const user = usersCache.find(u => u.id === id);
    if (!user) return;

    const isSuperAdmin = currentUser.role === 'super_admin';
    const roleOptions = `
        <option value="scanner_operator" ${user.role === 'scanner_operator' ? 'selected' : ''}>Scanner Operator</option>
        <option value="file_handler" ${user.role === 'file_handler' ? 'selected' : ''}>File Handler</option>
        ${isSuperAdmin ? `<option value="location_manager" ${user.role === 'location_manager' ? 'selected' : ''}>Location Manager</option>` : ''}
    `;

    openModal('Edit Employee', `
    <form id="editEmpForm">
      <div class="form-row">
        <div class="form-group">
          <label><i class="fas fa-user"></i> Full Name</label>
          <input type="text" id="editEmpName" value="${user.full_name}" required>
        </div>
        <div class="form-group">
          <label><i class="fas fa-user-tag"></i> Role</label>
          <select id="editEmpRole" class="form-select" >
            ${roleOptions}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label><i class="fas fa-barcode"></i> Scanner ID (optional)</label>
        <input type="text" id="editEmpScanner" value="${user.scanner_id || ''}" placeholder="e.g. Kodak i3400">
      </div>
      
      <!-- Salary Section -->
      <div class="form-row">
          <div class="form-group">
            <label><i class="fas fa-money-check-alt"></i> Salary Type</label>
            <select id="editEmpSalaryType" class="form-select" >
                <option value="per_page" ${user.salary_type === 'per_page' ? 'selected' : ''}>Per Page Rate</option>
                <option value="fixed" ${user.salary_type === 'fixed' ? 'selected' : ''}>Fixed Salary</option>
            </select>
          </div>
          <div class="form-group" id="editEmpRateGroup" style="${user.salary_type === 'fixed' ? 'display:none;' : ''}">
            <label><i class="fas fa-rupee-sign"></i> Per Page Rate</label>
            <input type="number" id="editEmpCustomRate" step="0.01" value="${user.custom_rate || ''}" placeholder="Default (Global)">
          </div>
          <div class="form-group" id="editEmpFixedGroup" style="${user.salary_type === 'fixed' ? '' : 'display:none;'}">
            <label><i class="fas fa-rupee-sign"></i> Monthly Salary</label>
            <input type="number" id="editEmpFixedSalary" value="${user.fixed_salary || ''}" placeholder="e.g. 15000">
          </div>
      </div>

      <div class="form-group">
          <label><i class="fas fa-lock"></i> New Password (optional)</label>
          <input type="password" id="editEmpPassword" placeholder="Leave blank to keep current">
      </div>

      <div style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;">
          <label style="display:flex;align-items:center;cursor:pointer;">
              <input type="checkbox" id="editEmpActive" ${user.is_active ? 'checked' : ''} style="margin-right:8px;transform:scale(1.2);">
              <span>Is Active Account</span>
          </label>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Save Changes</button>
      </div>
    </form>
  `);

    $('editEmpSalaryType').addEventListener('change', (e) => {
        if (e.target.value === 'fixed') {
            $('editEmpRateGroup').style.display = 'none';
            $('editEmpFixedGroup').style.display = 'block';
        } else {
            $('editEmpRateGroup').style.display = 'block';
            $('editEmpFixedGroup').style.display = 'none';
        }
    });

    $('editEmpForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch(`/users/${id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    full_name: $('editEmpName').value,
                    role: $('editEmpRole').value,
                    scanner_id: $('editEmpScanner').value,
                    is_active: $('editEmpActive').checked ? 1 : 0,
                    password: $('editEmpPassword').value || null,
                    salary_type: $('editEmpSalaryType').value,
                    custom_rate: $('editEmpCustomRate').value || null,
                    fixed_salary: $('editEmpFixedSalary').value || null
                })
            });
            showToast('Employee updated!');
            closeModal();
            loadEmployees();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
};

window.deleteEmployee = async function (id, name) {
    if (!confirm(`Are you sure you want to deactivate "${name}"?`)) return;
    try {
        await apiFetch(`/users/${id}`, { method: 'DELETE' });
        showToast('Employee deactivated');
        loadEmployees();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

// =================== SETTINGS ===================

async function loadSettings() {
    try {
        const settings = await apiFetch('/settings');
        const rate = settings.scan_rate || 0.10;
        if ($('settingScanRate')) $('settingScanRate').value = rate;
    } catch (err) {
        showToast('Failed to load settings', 'error');
    }
}

$('saveSettingsBtn')?.addEventListener('click', async () => {
    const rate = $('settingScanRate').value;
    if (!rate || rate < 0) {
        showToast('Please enter a valid rate', 'error');
        return;
    }

    try {
        await apiFetch('/settings', {
            method: 'PUT',
            body: JSON.stringify({ scan_rate: rate })
        });
        showToast('Settings saved successfully');
    } catch (err) {
        showToast('Failed to save settings: ' + err.message, 'error');
    }
});

// =================== INIT ===================

document.addEventListener('DOMContentLoaded', () => {
    if (getToken()) {
        showApp();
    } else {
        showLogin();
    }
});

// =================== EXPENSES ===================

async function loadExpenses() {
    const month = $('expensesMonthFilter')?.value;
    const locId = $('expensesLocationFilter')?.value;
    const params = new URLSearchParams();
    if (month) params.append('month', month);
    if (locId) params.append('location_id', locId);

    try {
        const expenses = await apiFetch(`/expenses?${params.toString()}`);
        const tbody = $('expensesList');
        if (!tbody) return;

        if (expenses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;">No expenses found</td></tr>`;
            if ($('expensesTotal')) $('expensesTotal').textContent = '₹0';
            return;
        }
        let total = 0;
        tbody.innerHTML = expenses.map(e => {
            total += parseFloat(e.amount);
            return `
            <tr>
                <td>${e.expense_date}</td>
                <td>${e.location_name}</td>
                <td>${e.description || '-'}</td>
                <td>₹${formatNumber(e.amount)}</td>
                <td><button class="action-btn delete" onclick="deleteExpense(${e.id})"><i class="fas fa-trash"></i></button></td>
            </tr>`;
        }).join('');
        if ($('expensesTotal')) $('expensesTotal').textContent = '₹' + formatNumber(total);
    } catch (e) { console.error(e); }
}

window.deleteExpense = async (id) => {
    if (!confirm('Delete this expense?')) return;
    try {
        await apiFetch(`/expenses/${id}`, { method: 'DELETE' });
        loadExpenses();
    } catch (e) { showToast(e.message, 'error'); }
};

$('addExpenseBtn')?.addEventListener('click', async () => {
    try {
        const locations = await apiFetch('/locations');
        const locOptions = locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('');

        openModal('Add Expense', `
        <form id="expenseForm">
          <div class="form-group">
            <label>Date</label>
            <input type="date" id="expDate" required value="${new Date().toISOString().slice(0, 10)}">
          </div>
          <div class="form-group">
            <label>Location / Project</label>
            <select id="expLocation" class="form-select" required>
                <option value="">Select Location</option>
                ${locOptions}
            </select>
          </div>
          <div class="form-group">
            <label>Amount (₹)</label>
            <input type="number" id="expAmount" step="0.01" required placeholder="0.00">
          </div>
          <div class="form-group">
            <label>Description</label>
            <input type="text" id="expDesc" placeholder="e.g. Transport, Food, Stationary">
          </div>
          <button type="submit" class="btn btn-primary btn-full">Add Expense</button>
        </form>
      `);

        $('expenseForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                await apiFetch('/expenses', {
                    method: 'POST',
                    body: JSON.stringify({
                        expense_date: $('expDate').value,
                        location_id: $('expLocation').value,
                        amount: $('expAmount').value,
                        description: $('expDesc').value
                    })
                });
                showToast('Expense added');
                closeModal();
                loadExpenses();
            } catch (e) { showToast(e.message, 'error'); }
        });
    } catch (e) { showToast('Failed to load locations: ' + e.message, 'error'); }
});

$('expensesMonthFilter')?.addEventListener('change', loadExpenses);
$('expensesLocationFilter')?.addEventListener('change', loadExpenses);

// Initialize filters
const todayDate = new Date();
const monthFilter = $('expensesMonthFilter');
if (monthFilter) monthFilter.value = todayDate.toISOString().slice(0, 7);

// Populate expenses location filter
async function loadExpensesFilter() {
    try {
        const locations = await apiFetch('/locations');
        const select = $('expensesLocationFilter');
        if (select) {
            select.innerHTML = '<option value="">All Locations</option>' +
                locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
        }
    } catch (e) { }
}
loadExpensesFilter();

// =================== ROLES ===================

let rolesCache = [];

async function loadRoles() {
    try {
        rolesCache = await apiFetch('/roles');
        const tbody = $('rolesList');

        if (rolesCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-muted);">No roles found</td></tr>`;
            return;
        }

        tbody.innerHTML = rolesCache.map(r => `
            <tr>
                <td><code style="background:var(--bg-input);padding:4px 8px;border-radius:4px;">${r.role_id}</code></td>
                <td><strong>${r.display_name}</strong></td>
                <td style="color:var(--text-muted);">${r.description || '-'}</td>
                <td>
                    ${r.is_system ? '<span style="color:var(--text-muted);font-size:12px;"><i class="fas fa-lock"></i> System</span>' : `
                        <div class="action-btns">
                            <button class="action-btn" onclick="editRole(${r.id})"><i class="fas fa-edit"></i></button>
                            <button class="action-btn delete" onclick="deleteRole(${r.id}, '${r.display_name}')"><i class="fas fa-trash"></i></button>
                        </div>
                    `}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showToast('Failed to load roles: ' + err.message, 'error');
    }
}

$('addRoleBtn')?.addEventListener('click', () => {
    openModal('Add New Role', `
        <form id="roleForm">
            <div class="form-group">
                <label><i class="fas fa-key"></i> Role ID</label>
                <input type="text" id="roleId" placeholder="e.g. qa_checker, supervisor" pattern="[a-z_]+" required>
                <small style="color:var(--text-muted);">Lowercase letters and underscores only</small>
            </div>
            <div class="form-group">
                <label><i class="fas fa-tag"></i> Display Name</label>
                <input type="text" id="roleDisplayName" placeholder="e.g. QA Checker, Supervisor" required>
            </div>
            <div class="form-group">
                <label><i class="fas fa-info-circle"></i> Description</label>
                <input type="text" id="roleDescription" placeholder="Brief description of this role">
            </div>
            <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-plus"></i> Create Role</button>
        </form>
    `);

    $('roleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch('/roles', {
                method: 'POST',
                body: JSON.stringify({
                    role_id: $('roleId').value.toLowerCase().replace(/\s+/g, '_'),
                    display_name: $('roleDisplayName').value,
                    description: $('roleDescription').value
                })
            });
            showToast('Role created successfully!');
            closeModal();
            loadRoles();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
});

window.editRole = function(id) {
    const role = rolesCache.find(r => r.id === id);
    if (!role) return;

    openModal('Edit Role', `
        <form id="editRoleForm">
            <div class="form-group">
                <label><i class="fas fa-key"></i> Role ID</label>
                <div style="padding:12px;background:var(--bg-input);border-radius:8px;color:var(--text-muted);">
                    <code>${role.role_id}</code> <small>(cannot be changed)</small>
                </div>
            </div>
            <div class="form-group">
                <label><i class="fas fa-tag"></i> Display Name</label>
                <input type="text" id="editRoleDisplayName" value="${role.display_name}" required>
            </div>
            <div class="form-group">
                <label><i class="fas fa-info-circle"></i> Description</label>
                <input type="text" id="editRoleDescription" value="${role.description || ''}">
            </div>
            <button type="submit" class="btn btn-primary btn-full"><i class="fas fa-save"></i> Save Changes</button>
        </form>
    `);

    $('editRoleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await apiFetch(`/roles/${id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    display_name: $('editRoleDisplayName').value,
                    description: $('editRoleDescription').value
                })
            });
            showToast('Role updated successfully!');
            closeModal();
            loadRoles();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
};

window.deleteRole = async function(id, name) {
    if (!confirm(`Are you sure you want to delete the role "${name}"?`)) return;
    try {
        await apiFetch(`/roles/${id}`, { method: 'DELETE' });
        showToast('Role deleted successfully');
        loadRoles();
    } catch (err) {
        showToast(err.message, 'error');
    }
};
