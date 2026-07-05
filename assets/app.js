const state = {
  rows: [],
  geojson: null,
  metadata: [],
  facets: {},
  analysis: null,
  mapFilters: { distance_class: new Set(), country_name: new Set(), nearest_hydro_entity_type: new Set() },
  categoricalFilters: {},
  numericFilters: {},
  search: "",
  selectedFacilityKey: null
};

const table5DefaultColumns = ["city", "facility_name", "sector_names"];
state.table5Columns = new Set(table5DefaultColumns);
const table6DefaultColumns = ["city", "facility_name", "sector_names"];
state.table6Columns = new Set(table6DefaultColumns);

const pointColors = {
  "0-100 m": "#b33a31",
  "100 m - 1 km": "#a76f16",
  "1-10 km": "#255c99"
};

const preferredColumns = [
  "facility_key", "facility_name", "city", "country_name",
  "distance_class", "distance_to_oder_hydro_boundary_km",
  "nearest_hydro_entity_type", "nearest_hydro_entity_name",
  "source_tables", "pollutant_count", "latest_pollutants",
  "air_release_total", "water_release_total", "pollutant_transfer_total",
  "waste_transfer_total", "ied_statuses", "lcp_feature_types"
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.filter(item => item.length === headers.length).map(item => {
    const record = {};
    headers.forEach((header, index) => { record[header] = item[index]; });
    return record;
  });
}

function selectedValues(select) {
  return Array.from(select.selectedOptions).map(option => option.value);
}

function fillSelect(select, values) {
  select.innerHTML = values.map(item => {
    const value = typeof item === "string" ? item : item.value;
    const count = typeof item === "string" ? "" : ` (${item.count})`;
    return `<option value="${escapeHtml(value)}">${escapeHtml(value)}${count}</option>`;
  }).join("");
}

function splitValues(value) {
  return String(value || "").split(/[;|]/).map(item => item.trim()).filter(Boolean);
}

function passesSetFilter(value, set, multi = false) {
  if (!set || set.size === 0) return true;
  if (multi) {
    return splitValues(value).some(item => set.has(item));
  }
  return set.has(String(value || ""));
}

function rowMatches(row, includeMapFilters = true) {
  const text = state.search.trim().toLowerCase();
  if (text) {
    const hit = Object.values(row).some(value => String(value || "").toLowerCase().includes(text));
    if (!hit) return false;
  }
  if (includeMapFilters) {
    for (const [column, set] of Object.entries(state.mapFilters)) {
      if (!passesSetFilter(row[column], set)) return false;
    }
  }
  for (const [column, set] of Object.entries(state.categoricalFilters)) {
    const control = state.facets[column]?.control;
    if (!passesSetFilter(row[column], set, control === "multi_value")) return false;
  }
  for (const [column, limits] of Object.entries(state.numericFilters)) {
    const value = Number(row[column]);
    if (limits.min !== "" && (Number.isNaN(value) || value < Number(limits.min))) return false;
    if (limits.max !== "" && (Number.isNaN(value) || value > Number(limits.max))) return false;
  }
  return true;
}

function rowMatchesMap(row) {
  for (const [column, set] of Object.entries(state.mapFilters)) {
    if (!passesSetFilter(row[column], set)) return false;
  }
  return true;
}

function filteredRows() {
  return state.rows.filter(row => rowMatches(row));
}

function postMapFilters(fitBounds = false) {
  const iframe = document.getElementById("facility-map");
  if (!iframe || !iframe.contentWindow) return;
  const filters = {};
  Object.entries(state.mapFilters).forEach(([column, set]) => {
    filters[column] = Array.from(set);
  });
  iframe.contentWindow.postMessage({ type: "facilityFilters", filters, fitBounds }, "*");
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(tab => tab.classList.remove("is-active"));
      document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.remove("is-active"));
      button.classList.add("is-active");
      document.getElementById(`tab-${button.dataset.tab}`).classList.add("is-active");
      if (button.dataset.tab === "map") renderMap();
    });
  });
}

function setupSummary() {
  const overview = state.analysis.overview;
  document.getElementById("stat-facilities").textContent = overview.facility_rows.toLocaleString();
  document.getElementById("stat-columns").textContent = overview.column_count.toLocaleString();
  document.getElementById("stat-hydro").textContent = overview.selected_hydro_entity_count.toLocaleString();
}

function setupMapBridge() {
  const iframe = document.getElementById("facility-map");
  iframe.addEventListener("load", () => renderMap());
  window.addEventListener("message", event => {
    const data = event.data || {};
    if (data.type === "facilitySelected") {
      const row = state.rowsByKey.get(data.facilityKey);
      if (row) {
        state.selectedFacilityKey = data.facilityKey;
        renderDetail(row);
      }
    }
    if (data.type === "facilityMapReady") {
      postMapFilters(true);
    }
  });
}

function setupMapFilters() {
  const mappings = [
    ["map-distance-filter", "distance_class"],
    ["map-country-filter", "country_name"],
    ["map-hydro-filter", "nearest_hydro_entity_type"]
  ];
  mappings.forEach(([id, column]) => {
    const select = document.getElementById(id);
    fillSelect(select, state.facets[column]?.values || []);
    select.addEventListener("change", () => {
      state.mapFilters[column] = new Set(selectedValues(select));
      renderMap();
      renderTable();
    });
  });
  document.getElementById("map-reset").addEventListener("click", () => {
    mappings.forEach(([id, column]) => {
      document.getElementById(id).selectedIndex = -1;
      state.mapFilters[column] = new Set();
    });
    renderMap();
    renderTable();
  });
  document.getElementById("map-fit").addEventListener("click", renderMap);
}

function setupLookupFilters() {
  const categoricalRoot = document.getElementById("categorical-filters");
  const numericRoot = document.getElementById("numeric-filters");
  const categoricalColumns = [
    "country_name", "distance_class", "nearest_hydro_entity_type",
    "nearest_hydro_source_layer", "source_tables", "sector_names",
    "pollutants", "waste_classifications", "ied_statuses", "bat_conclusions",
    "lcp_feature_types"
  ].filter(column => state.facets[column]);
  categoricalRoot.innerHTML = categoricalColumns.map(column => `
    <label>${escapeHtml(column)}
      <select data-filter-column="${escapeHtml(column)}" multiple>
        ${(state.facets[column].values || []).slice(0, 120).map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.value)} (${item.count})</option>`).join("")}
      </select>
    </label>
  `).join("");
  categoricalRoot.querySelectorAll("select").forEach(select => {
    select.addEventListener("change", () => {
      state.categoricalFilters[select.dataset.filterColumn] = new Set(selectedValues(select));
      renderTable();
    });
  });

  const numericColumns = state.metadata
    .filter(item => item.suggested_control === "numeric_range")
    .map(item => item.name)
    .filter(column => preferredColumns.includes(column) || [
      "distance_to_oder_hydro_boundary_m", "longitude", "latitude",
      "first_year", "latest_year", "reporting_year_count",
      "source_record_count", "pollutant_count", "air_release_total",
      "water_release_total", "pollutant_transfer_total", "waste_transfer_total",
      "lcp_feature_value_total", "wi_cowi_capacity_total"
    ].includes(column));
  numericRoot.innerHTML = numericColumns.map(column => {
    const meta = state.metadata.find(item => item.name === column) || {};
    return `
      <label>${escapeHtml(column)}
        <div class="range-grid">
          <input data-number-column="${escapeHtml(column)}" data-bound="min" type="number" step="any" placeholder="min ${escapeHtml(meta.min ?? "")}">
          <input data-number-column="${escapeHtml(column)}" data-bound="max" type="number" step="any" placeholder="max ${escapeHtml(meta.max ?? "")}">
        </div>
      </label>
    `;
  }).join("");
  numericRoot.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", () => {
      const column = input.dataset.numberColumn;
      state.numericFilters[column] = state.numericFilters[column] || { min: "", max: "" };
      state.numericFilters[column][input.dataset.bound] = input.value;
      renderTable();
    });
  });

  document.getElementById("global-search").addEventListener("input", event => {
    state.search = event.target.value;
    renderTable();
  });
  document.getElementById("lookup-reset").addEventListener("click", () => {
    state.search = "";
    state.categoricalFilters = {};
    state.numericFilters = {};
    document.getElementById("global-search").value = "";
    categoricalRoot.querySelectorAll("select").forEach(select => { select.selectedIndex = -1; });
    numericRoot.querySelectorAll("input").forEach(input => { input.value = ""; });
    renderTable();
  });
  document.getElementById("export-filtered").addEventListener("click", exportFilteredCsv);
}

function renderMap() {
  const rows = state.rows.filter(row => rowMatchesMap(row));
  document.getElementById("map-count").textContent = rows.length.toLocaleString();
  postMapFilters(true);
}

function renderDetail(props) {
  const fields = [
    "facility_name", "facility_key", "city", "country_name",
    "distance_class", "distance_to_oder_hydro_boundary_km",
    "nearest_hydro_entity_type", "nearest_hydro_source_layer",
    "nearest_hydro_entity_id", "nearest_hydro_entity_name",
    "source_tables", "latest_pollutants"
  ];
  document.getElementById("map-detail").innerHTML = `
    <div class="section-title">Selected facility</div>
    <dl class="detail-list">
      ${fields.map(field => `<div><dt>${escapeHtml(field)}</dt><dd>${escapeHtml(props[field] ?? "")}</dd></div>`).join("")}
    </dl>
  `;
}

function renderTable() {
  const rows = filteredRows();
  document.getElementById("lookup-count").textContent = rows.length.toLocaleString();
  const columns = preferredColumns.filter(column => state.metadata.some(item => item.name === column));
  const table = document.getElementById("facility-table");
  const visibleRows = rows.slice(0, 250);
  table.innerHTML = `
    <thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
    <tbody>
      ${visibleRows.map(row => `<tr>${columns.map(column => `<td title="${escapeHtml(row[column] || "")}">${escapeHtml(row[column] || "")}</td>`).join("")}</tr>`).join("")}
    </tbody>
  `;
}

function exportFilteredCsv() {
  const rows = filteredRows();
  const columns = state.metadata.map(item => item.name);
  const csv = [
    columns.join(","),
    ...rows.map(row => columns.map(column => {
      const value = String(row[column] ?? "");
      return `"${value.replaceAll('"', '""')}"`;
    }).join(","))
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "oder_facilities_filtered.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderReportTable(title, records, limit = null) {
  if (!records || !records.length) return "<p class='muted'>No records available.</p>";
  const rows = limit ? records.slice(0, limit) : records;
  const columns = Object.keys(rows[0]);
  const truncated = limit && records.length > limit;
  return `
    <figure class="report-table-block">
      <figcaption>${escapeHtml(title)}</figcaption>
      <table class="mini-table">
        <thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      ${truncated ? `<p class="muted">Showing ${rows.length.toLocaleString()} of ${records.length.toLocaleString()} records. Use the linked CSV download for the full table.</p>` : ""}
    </figure>
  `;
}

function renderReportTableWithColumns(title, records, selectedColumns, limit = null) {
  if (!records || !records.length) return "<p class='muted'>No records available.</p>";
  const availableColumns = Object.keys(records[0]);
  const columns = selectedColumns.filter(column => availableColumns.includes(column));
  const rows = limit ? records.slice(0, limit) : records;
  const truncated = limit && records.length > limit;
  return `
    <figure class="report-table-block">
      <figcaption>${escapeHtml(title)}</figcaption>
      ${columns.length ? `
        <table class="mini-table">
          <thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      ` : "<p class='muted'>Select at least one column to display this table.</p>"}
      ${truncated ? `<p class="muted">Showing ${rows.length.toLocaleString()} of ${records.length.toLocaleString()} records. Use the linked CSV download for the full table.</p>` : ""}
    </figure>
  `;
}

function renderReportColumnPicker(tableKey, label, records, selectedColumns) {
  if (!records || !records.length) return "";
  const availableColumns = Object.keys(records[0]);
  return `
    <div class="column-picker" aria-label="${escapeHtml(label)} visible columns">
      <div class="column-picker-title">${escapeHtml(label)} visible columns</div>
      <div class="checkbox-grid">
        ${availableColumns.map(column => `
          <label class="checkbox-pill">
            <input data-report-column-table="${escapeHtml(tableKey)}" data-report-column="${escapeHtml(column)}" type="checkbox" ${selectedColumns.has(column) ? "checked" : ""}>
            <span>${escapeHtml(column)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;
}

function setupReportControls() {
  document.querySelectorAll("[data-report-column-table]").forEach(input => {
    input.addEventListener("change", () => {
      const column = input.dataset.reportColumn;
      const stateKey = `${input.dataset.reportColumnTable}Columns`;
      const selectedColumns = state[stateKey];
      if (!selectedColumns) return;
      if (input.checked) {
        selectedColumns.add(column);
      } else {
        selectedColumns.delete(column);
      }
      renderReport();
    });
  });
}

function renderReport() {
  const overview = state.analysis.overview;
  const tables = state.analysis.tables;
  const table5Columns = Array.from(state.table5Columns);
  const table6Columns = Array.from(state.table6Columns);
  document.getElementById("report-links").innerHTML = state.analysis.links.map(link => `
    <a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>
    <span class="muted">${escapeHtml(link.description)}</span>
  `).join("");
  document.getElementById("report-content").innerHTML = `
    <section class="report-card">
      <div class="metric-row">
        <div class="metric"><strong>${overview.facility_rows.toLocaleString()}</strong><span>facilities within 10 km</span></div>
        <div class="metric"><strong>${overview.within_1km_count.toLocaleString()}</strong><span>facilities within 1 km</span></div>
        <div class="metric"><strong>${overview.within_100m_count.toLocaleString()}</strong><span>facilities within 100 m</span></div>
        <div class="metric"><strong>${overview.selected_hydro_entity_count.toLocaleString()}</strong><span>selected hydro entities</span></div>
      </div>
    </section>
    <section class="report-card">
      <h3>Distance and hydro boundary checks</h3>
      ${renderReportTable("Table 1. Distance and hydro-boundary checks", tables.distance_hydro_checks)}
    </section>
    <section class="report-card">
      <h3>Facility type and proximity</h3>
      <p>Source-table and sector counts are shown separately for 0-100 m, 100 m - 1 km, and 1-10 km so the closest band is not hidden by the larger outer band.</p>
      ${renderReportTable("Table 2. Source tables by distance class", tables.source_by_distance, 24)}
      ${renderReportTable("Table 3. Sector names by distance class", tables.sector_by_distance, 24)}
    </section>
    <section class="report-card">
      <h3>Major pollutants</h3>
      <p>Pollutant counts use the latest pollutant list carried by the 10 km facility table. Proportions are calculated against all 1,611 facilities in the 10 km subset.</p>
      ${renderReportTable("Table 4. All reported pollutants with facility proportions", tables.pollutants)}
    </section>
    <section class="report-card">
      <h3>Water-release chlorine/chloride records</h3>
      <p>These records are joined from the 10 km facility table to the pollutant fact table, filtered to water-release facts and chlorine/chloride pollutant names.</p>
      ${renderReportColumnPicker("table5", "Table 5", tables.chlorine_chloride_facilities, state.table5Columns)}
      ${renderReportTableWithColumns("Table 5. Facilities with water-release records for chlorine/chloride pollutants", tables.chlorine_chloride_facilities, table5Columns, 40)}
      ${renderReportTable("Expected chlorine/chloride pollutant check", tables.chlorine_chloride_expected_pollutants)}
    </section>
    <section class="report-card">
      <h3>Polish Mineral industry subset</h3>
      <p>This table keeps the E-PRTR sector scope exactly as tagged in the Phase 1 facility table: country Poland and sector name Mineral industry.</p>
      ${renderReportColumnPicker("table6", "Table 6", tables.polish_mineral_facilities, state.table6Columns)}
      ${renderReportTableWithColumns("Table 6. Polish facilities tagged by E-PRTR as Mineral industry", tables.polish_mineral_facilities, table6Columns, 40)}
    </section>
    <section class="report-card">
      <h3>Released compounds for Polish Mineral industry</h3>
      <p>Compound rows are summarized from pollutant facts for the Table 6 facility keys and separated by source table and target release.</p>
      ${renderReportTable("Table 6A. Released chemical compounds for Polish Mineral industry facilities", tables.polish_mineral_compounds, 50)}
    </section>
    <section class="report-card">
      <h3>Code-derived checks</h3>
      ${state.analysis.code_snippets.map(item => `<h3>${escapeHtml(item.title)}</h3><pre><code>${escapeHtml(item.code)}</code></pre>`).join("")}
    </section>
  `;
  setupReportControls();
}

async function loadApp() {
  const [csvText, geojson, metadata, facets, analysis] = await Promise.all([
    fetch("data/facilities.csv").then(response => response.text()),
    fetch("data/facilities.geojson").then(response => response.json()),
    fetch("data/column_metadata.json").then(response => response.json()),
    fetch("data/facet_indexes.json").then(response => response.json()),
    fetch("data/analysis_summary.json").then(response => response.json())
  ]);
  state.rows = parseCsv(csvText);
  state.rowsByKey = new Map(state.rows.map(row => [row.facility_key, row]));
  state.geojson = geojson;
  state.metadata = metadata;
  state.facets = facets;
  state.analysis = analysis;
  setupTabs();
  setupSummary();
  setupMapBridge();
  setupMapFilters();
  setupLookupFilters();
  renderMap();
  renderTable();
  renderReport();
}

loadApp().catch(error => {
  document.body.innerHTML = `<pre>Failed to load Phase 2 site assets: ${escapeHtml(error.message)}</pre>`;
  console.error(error);
});
