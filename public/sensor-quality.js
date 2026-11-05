(function (root) {
  'use strict';
  // Snapshot of the versioned archive policy/layout. The policy parity test
  // prevents Current/Daily from drifting when station configuration changes.
  const policy = {"stationId":"moore-weather","earliestLocalTimestamp":"2025-06-12T00:00:00","pressureMinHpa":850,"pressureMaxHpa":1100,"sensorLimits":[{"sensorKey":"4","minimum":-15,"maximum":55,"note":"Conservative local air-temperature screening; preserve genuine frost. Owner authorised screening on 11 October 2026."},{"sensorKey":"58","minimum":-15,"maximum":85,"note":"Black globe may exceed air temperature in sunlight."},{"sensorKey":"9","minimum":-15,"maximum":80,"note":"Surface soil can be hotter than air."},{"sensorKey":"46","minimum":-15,"maximum":65,"note":"Buried soil temperature screening."},{"sensorKey":"47","minimum":-15,"maximum":65,"note":"Buried soil temperature screening."},{"sensorKey":"48","minimum":-15,"maximum":65,"note":"Buried soil temperature screening."},{"sensorKey":"49","minimum":-15,"maximum":65,"note":"Buried soil temperature screening."},{"sensorKey":"34","minimum":-60,"maximum":55,"note":"Dew point may be much lower than air temperature in dry conditions."},{"sensorKey":"6","minimum":-5,"maximum":2000,"floorZero":true,"note":"Floor plausible negative sensor-baseline readings at zero in usable data. More extreme values are excluded, not disguised as zero. Original readings retained. Aggregate flooring cannot reconstruct sample-level clamping."}],"note":"Owner authorised omitting history before the current format and vetting obvious junk on 30 September 2026. Start usable history on the date of the first verified current-format daily record. Station pressure was repeatedly stuck around 809.2 hPa from July to October 2025, with a minimum at the configured zero-input offset of 804.2. Treat pressure outside 850\u20131100 hPa as suspect at this station and omit pressure aggregates from any affected record; keep its other sensors. Original records remain archived. This is screening, not a calibration correction."};
  const sensorLimits = Object.fromEntries(policy.sensorLimits.map(limit => [limit.sensorKey, limit]));
  const sensors = {"1":{"name":"Wind Speed","unit":"km/h"},"2":{"name":"Wind Direct","unit":"Degs"},"3":{"name":"Humidity","unit":"%"},"4":{"name":"Air Temp","unit":"DegC"},"5":{"name":"Rain Gauge","unit":"mm"},"6":{"name":"Sun UV","unit":"Watts/m2"},"7":{"name":"Pressure","unit":"hPa"},"9":{"name":"Dirt Temp","unit":"DegC"},"17":{"name":"WDIR Cosine","unit":""},"18":{"name":"WDIR Sine","unit":""},"21":{"name":"Battery","unit":"V"},"22":{"name":"Load","unit":"mA"},"23":{"name":"Solar","unit":"V"},"24":{"name":"Charge","unit":"mA"},"25":{"name":"Peak Wind Gust","unit":"km/h"},"26":{"name":"Vector Wind Spd","unit":"km/h"},"27":{"name":"Vector Wind Dir","unit":"Degs"},"28":{"name":"N/-S Wind Sp (VCos)","unit":"km/h"},"29":{"name":"E/-W Wind Sp (VSin)","unit":"km/h"},"30":{"name":"Rain TOTAL","unit":"mm"},"31":{"name":"Evaporation Rate","unit":"mm/h"},"32":{"name":"Communications","unit":"mins"},"33":{"name":"Daily Evaporation","unit":"mm"},"34":{"name":"Dew Point","unit":"DegC"},"46":{"name":"Soil Temp 10 cm","unit":"deg C"},"47":{"name":"Soil Temp 20 cm","unit":"deg C"},"48":{"name":"Soil Temp 30 cm","unit":"deg C"},"49":{"name":"Soil Temp 40 cm","unit":"deg C"},"54":{"name":"Moisture 10 cm","unit":"VWC %"},"55":{"name":"Moisture 20 cm","unit":"VWC %"},"56":{"name":"Moisture 30 cm","unit":"VWC %"},"57":{"name":"Moisture 40 cm","unit":"VWC %"},"58":{"name":"Black Globe Temp","unit":"DegC"},"62":{"name":"EnvPro Status","unit":"Counts"}};
  const currentSensors = ["1", "2", "3", "4", "5", "6", "7", "9", "21", "22", "23", "24", "25", "26", "27", "30", "31", "32", "33", "34", "46", "47", "48", "49", "54", "55", "56", "57", "58"];
  const dailySensors = ["1", "1", "1", "2", "2", "25", "26", "27", "3", "3", "3", "4", "4", "4", "5", "6", "33", "34", "21", "32", "22", "23", "24", "46", "47", "48", "49", "54", "55", "56", "57", "9", "9", "9", "7", "7", "7", "6", "58", "58", "58"];
  const numeric = raw => raw !== null && raw !== undefined && String(raw).trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;

  function validSensorValue(value, key) {
    if (!Number.isFinite(value)) return false;
    const limits = sensorLimits[key];
    if (limits && (value < limits.minimum || value > limits.maximum)) return false;
    const unit = sensors[key]?.unit;
    if ((unit === '%' || unit === 'VWC %') && (value < 0 || value > 100)) return false;
    if (['1', '25', '26'].includes(key) && value < 0) return false;
    if (['5', '30'].includes(key) && value < 0) return false;
    if (unit === 'Degs' && (value < 0 || value > 360)) return false;
    if (['DegC', 'deg C'].includes(unit) && (value < -90 || value > 100)) return false;
    if (key === '7' && (value < policy.pressureMinHpa || value > policy.pressureMaxHpa)) return false;
    return true;
  }

  function screenValues(raw, sensorKeys) {
    const numericValues = raw.map(numeric);
    // Archive temperature/solar and pressure limits apply to the whole sensor
    // record: an invalid daily extremum also invalidates its daily average.
    const badGroups = new Set();
    numericValues.forEach((value, i) => {
      const key = sensorKeys[i], limits = sensorLimits[key];
      if (value === null) return;
      if ((limits && (value < limits.minimum || value > limits.maximum)) ||
          (key === '7' && (value < policy.pressureMinHpa || value > policy.pressureMaxHpa))) badGroups.add(key);
    });
    const unavailable = new Set();
    const values = numericValues.map((value, i) => {
      const key = sensorKeys[i];
      if (badGroups.has(key) || !validSensorValue(value, key)) {
        unavailable.add(key);
        return null;
      }
      return sensorLimits[key]?.floorZero ? Math.max(0, value) : value;
    });
    return { values, unavailable: [...unavailable], unavailableNames: [...unavailable].map(key => sensors[key]?.name || 'Sensor') };
  }

  function parseCurrent(csv) {
    const fields = String(csv).replace(/^r3\s*/i, '').trim().replace(/,?END$/, '').split(',').map(field => field.trim());
    if (fields.length < 31) throw new Error('The current station record is incomplete.');
    const [date, time] = fields;
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw new Error('The station observation time is invalid.');
    const [year, month, day] = date.split('/').map(Number);
    const calendar = Date.UTC(year, month - 1, day);
    if (new Date(calendar).toISOString().slice(0, 10) !== date.replaceAll('/', '-')) throw new Error('The station observation date is invalid.');
    return { ...screenValues(fields.slice(2, 31), currentSensors), observedAt: date.replaceAll('/', '-') + 'T' + time + '+10:00' };
  }

  const api = { policy, sensors, currentSensors, dailySensors, numeric, validSensorValue, screenValues, parseCurrent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WeatherQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
