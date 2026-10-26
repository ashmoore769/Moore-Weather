'use strict';
// Explicit read-only provider check. Never starts the station server.
const { textRequest } = require('../lib/water-client');
const { connollyReport, CONNOLLY_URL } = require('../lib/water-connolly');
(async () => {
  const html = await textRequest(CONNOLLY_URL);
  try {
    const report = connollyReport(html);
    console.log(JSON.stringify({ source: CONNOLLY_URL, reportDate: report.reportDate,
      readings: report.rows.map(r => ({ metric: r.metric, value: r.value })) }));
  } catch (error) {
    // Public source markup only, bounded to help diagnose provider layout changes.
    const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].find(m => /Capacity\s*Full/i.test(m[0]));
    console.error('Council table excerpt:', table?.[0].slice(0,12000) || 'not found');
    throw error;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
