'use strict';

// Synthetic configuration for offline tests. These dates and capture details
// do not describe a real station change or an actual evidence attachment.
const { createHash } = require('node:crypto');
const baseline = require('../../config/station-layout.json');
const hash = value => createHash('sha256').update(value).digest('hex');

module.exports = {
  id: 'fixture-mem3-globe',
  stationId: baseline.station.id,
  stationSerial: baseline.station.serial,
  stream: 'mem3',
  baselineLayoutSha256: hash(JSON.stringify(baseline)),
  scheduleChangedAt: '2025-04-02T00:04:00.000Z',
  confirmedStationAt: '2025-04-02T00:05:40.000Z',
  firstNewObservedAt: '2025-04-02T00:10:00.000Z',
  firstCompleteObservedAt: '2025-04-02T00:20:00.000Z',
  storageId: 77,
  position: 4,
  before: { sensorKey: '2', aggregation: 'S-THETA', name: 'Wind Direct', unit: 'Degs' },
  after: { sensorKey: '58', aggregation: 'AVERAGE', name: 'Black Globe Temp', unit: 'DegC' },
  evidence: {
    captureName: 'synthetic-layout-change.txt',
    captureSha256: hash('Synthetic offline fixture; no production station capture.'),
    command: 'Synthetic replacement of one MEM3 field for tests only.',
    savedByOwner: true,
    note: 'Synthetic offline cutover: the first interval is partial and the following interval is complete.'
  }
};
