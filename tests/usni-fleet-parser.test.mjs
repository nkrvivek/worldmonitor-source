import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);

const {
  usniDetectStatus,
  usniExtractBattleForceSummary,
  usniGetRegionCoords,
  usniHullToType,
  usniParseArticle,
  usniParseLeadingInt,
  usniStripHtml,
} = require('../scripts/lib/usni-fleet-parser.cjs');

const ARTICLE_URL = 'https://news.usni.org/2026/06/10/usni-fleet-tracker';
const ARTICLE_DATE = '2026-06-10T12:00:00';
const ARTICLE_TITLE = 'USNI Fleet and Marine Tracker: June 10, 2026';

function buildFixtureHtml() {
  return `
    <table>
      <tr>
        <th>Battle Force Ships</th>
        <th>Deployed Ships</th>
        <th>Underway Ships</th>
      </tr>
      <tr>
        <td>298 ships</td>
        <td>105 deployed</td>
        <td>77 underway</td>
      </tr>
    </table>
    <h2>In the Philippine Sea</h2>
    <h3>Abraham Lincoln Carrier Strike Group</h3>
    <p>
      The Abraham Lincoln Carrier Strike Group is deployed with Carrier Air Wing Nine.
      USS <em>Abraham Lincoln</em> (CVN-72) and USS Spruance (DDG-111) are homeported in San Diego.
      USS Spruance (DDG-111) appears twice in the article text.
    </p>
    <h3>John Lewis Replenishment Group</h3>
    <p>
      USNS John Lewis (T-AO-205) is underway in support of the group.
    </p>
    <h2>Mystery Theater</h2>
    <p>
      USS Example (DDG-999) is in port and homeported at Norfolk.
    </p>
  `;
}

describe('USNI fleet parser helpers', () => {
  it('normalizes HTML text and leading integers', () => {
    assert.equal(
      usniStripHtml('<p>USS&nbsp;Ford &amp; escorts &#8211; <strong>deployed</strong></p>'),
      'USS Ford & escorts \u2013 deployed',
    );
    assert.equal(usniParseLeadingInt('1,234 sailors'), 1234);
    assert.equal(usniParseLeadingInt('no count'), undefined);
  });

  it('decodes exactly one entity level and never double-decodes escaped markup', () => {
    // A fleet report line whose literal text is `&lt;DDG-111&gt;` escapes to
    // `&amp;lt;DDG-111&amp;gt;`. Decoding `&amp;` before `&lt;` yields `<DDG-111>`.
    assert.equal(
      usniStripHtml('USS Spruance &amp;lt;DDG-111&amp;gt;'),
      'USS Spruance &lt;DDG-111&gt;',
    );
    assert.equal(usniStripHtml('Crew &amp;#8217;s morale'), 'Crew &#8217;s morale');
    assert.equal(usniStripHtml('Fish &amp;amp; Chips'), 'Fish &amp; Chips');

    // Legitimately encoded text still decodes exactly once.
    assert.equal(usniStripHtml('Fish &amp; Chips'), 'Fish & Chips');
    assert.equal(usniStripHtml('range 5 &lt; x &gt; 2'), 'range 5 < x > 2');
    assert.equal(usniStripHtml('Admiral&#8217;s &#8220;quote&#8221; &#8211; page'), 'Admiral\'s "quote" \u2013 page');
    assert.equal(usniStripHtml('USS&nbsp;Ford'), 'USS Ford');
  });

  it('classifies hull types, deployment status, and region coordinates', () => {
    assert.equal(usniHullToType('CVN-72'), 'carrier');
    assert.equal(usniHullToType('T-AO-205'), 'auxiliary');
    assert.equal(usniHullToType('XYZ-1'), 'unknown');

    assert.equal(usniDetectStatus('currently deployed in theater'), 'deployed');
    assert.equal(usniDetectStatus('transiting the strait'), 'underway');
    assert.equal(usniDetectStatus('pierside at homeport'), 'in-port');
    assert.equal(usniDetectStatus('routine maintenance'), 'unknown');

    assert.deepEqual(usniGetRegionCoords('In the Philippine Sea'), { lat: 18, lon: 130 });
    assert.deepEqual(usniGetRegionCoords('Western Pacific near Guam'), { lat: 20, lon: 140 });
    assert.deepEqual(usniGetRegionCoords('Laem Chabang, Thailand anchorage'), { lat: 13.08, lon: 100.88 });
    assert.deepEqual(usniGetRegionCoords('Eastern Mediterranean Sea'), { lat: 34.5, lon: 33 });
    assert.deepEqual(usniGetRegionCoords('Gulf of Oman / Arabian Sea'), { lat: 24.5, lon: 58.5 });
    assert.equal(usniGetRegionCoords('Not A Real Theater'), null);
  });

  it('extracts battle force summary counts from the first table', () => {
    const summary = usniExtractBattleForceSummary(`
      <tr><th>Total battle force</th><th>Deployed</th><th>Underway</th></tr>
      <tr><td>298</td><td>105</td><td>77</td></tr>
    `);

    assert.deepEqual(summary, { totalShips: 298, deployed: 105, underway: 77 });
    assert.equal(usniExtractBattleForceSummary('<tr><th>Name</th></tr><tr><td>Nimitz</td></tr>'), undefined);
  });

  it('parses article metadata, regions, strike groups, vessels, and warnings', () => {
    const report = usniParseArticle(buildFixtureHtml(), ARTICLE_URL, ARTICLE_DATE, ARTICLE_TITLE);

    assert.equal(report.articleUrl, ARTICLE_URL);
    assert.equal(report.articleDate, ARTICLE_DATE);
    assert.equal(report.articleTitle, ARTICLE_TITLE);
    assert.deepEqual(report.battleForceSummary, { totalShips: 298, deployed: 105, underway: 77 });
    assert.deepEqual(new Set(report.regions), new Set(['Philippine Sea', 'Mystery Theater']));
    assert.deepEqual(report.parsingWarnings, ['Unknown region: "Mystery Theater"']);
    assert.equal(Number.isFinite(report.timestamp), true);

    assert.equal(report.vessels.length, 4);

    const carrier = report.vessels.find((v) => v.hullNumber === 'CVN-72');
    assert.deepEqual(
      {
        name: carrier.name,
        vesselType: carrier.vesselType,
        region: carrier.region,
        regionLat: carrier.regionLat,
        regionLon: carrier.regionLon,
        deploymentStatus: carrier.deploymentStatus,
        homePort: carrier.homePort,
        strikeGroup: carrier.strikeGroup,
        articleUrl: carrier.articleUrl,
        articleDate: carrier.articleDate,
      },
      {
        name: 'USS Abraham Lincoln',
        vesselType: 'carrier',
        region: 'Philippine Sea',
        regionLat: 18,
        regionLon: 130,
        deploymentStatus: 'deployed',
        homePort: 'San Diego',
        strikeGroup: 'Abraham Lincoln Carrier Strike Group',
        articleUrl: ARTICLE_URL,
        articleDate: ARTICLE_DATE,
      },
    );

    const oiler = report.vessels.find((v) => v.hullNumber === 'T-AO-205');
    assert.equal(oiler.name, 'USNS John Lewis');
    assert.equal(oiler.vesselType, 'auxiliary');
    assert.equal(oiler.deploymentStatus, 'underway');

    const unknownRegionShip = report.vessels.find((v) => v.hullNumber === 'DDG-999');
    assert.equal(unknownRegionShip.region, 'Mystery Theater');
    assert.equal(unknownRegionShip.regionLat, 0);
    assert.equal(unknownRegionShip.regionLon, 0);
    assert.equal(unknownRegionShip.deploymentStatus, 'in-port');
    assert.equal(unknownRegionShip.homePort, 'Norfolk');

    const strikeGroup = report.strikeGroups.find((sg) => sg.name === 'Abraham Lincoln Carrier Strike Group');
    assert.equal(strikeGroup.carrier, 'USS Abraham Lincoln (CVN-72)');
    assert.equal(strikeGroup.airWing, 'Carrier Air Wing Nine');
    assert.deepEqual(strikeGroup.escorts, [
      'USS Abraham Lincoln (CVN-72)',
      'USS Spruance (DDG-111)',
    ]);
  });

  it('deduplicates repeated hulls inside a region but keeps region-scoped records distinct', () => {
    const html = `
      <h2>Philippine Sea</h2>
      <p>USS Spruance (DDG-111) is deployed. USS Spruance (DDG-111) is mentioned again.</p>
      <h2>South China Sea</h2>
      <p>USS Spruance (DDG-111) is underway in a separate region paragraph.</p>
    `;

    const report = usniParseArticle(html, ARTICLE_URL, ARTICLE_DATE, ARTICLE_TITLE);
    const spruanceRows = report.vessels.filter((v) => v.hullNumber === 'DDG-111');

    assert.equal(spruanceRows.length, 2);
    assert.deepEqual(
      spruanceRows.map((v) => [v.region, v.deploymentStatus]),
      [
        ['Philippine Sea', 'deployed'],
        ['South China Sea', 'underway'],
      ],
    );
  });

  it('persists the most-specific coordinates for overlapping USNI region labels', () => {
    const html = `
      <h2>Eastern Mediterranean Sea</h2>
      <p>USS Arleigh Burke (DDG-51) is deployed.</p>
      <h2>Gulf of Oman / Arabian Sea</h2>
      <p>USS Fitzgerald (DDG-62) is underway.</p>
    `;

    const report = usniParseArticle(html, ARTICLE_URL, ARTICLE_DATE, ARTICLE_TITLE);
    const burke = report.vessels.find((v) => v.hullNumber === 'DDG-51');
    const fitzgerald = report.vessels.find((v) => v.hullNumber === 'DDG-62');

    assert.deepEqual(
      {
        region: burke.region,
        regionLat: burke.regionLat,
        regionLon: burke.regionLon,
      },
      {
        region: 'Eastern Mediterranean Sea',
        regionLat: 34.5,
        regionLon: 33,
      },
    );
    assert.deepEqual(
      {
        region: fitzgerald.region,
        regionLat: fitzgerald.regionLat,
        regionLon: fitzgerald.regionLon,
      },
      {
        region: 'Gulf of Oman / Arabian Sea',
        regionLat: 24.5,
        regionLon: 58.5,
      },
    );
  });
});

describe('region name matching', () => {
  it('resolves a region name shorter than its table key', () => {
    // USNI wrote "In the Caribbean" on 2026-08-19. The table holds
    // "Caribbean Sea", and the old matcher only asked whether the article's
    // name contained a key, never the reverse, so the ship came out at 0,0
    // with a parser warning. The TypeScript side (getUSNIRegionCoords in
    // src/config/military.ts) has always matched both directions; this makes
    // the two agree.
    const html = [
      '<h2>In the Caribbean</h2>',
      '<h3>Gerald R. Ford Carrier Strike Group</h3>',
      '<p>USS Gerald R. Ford (CVN-78) is deployed.</p>',
    ].join('');
    const report = usniParseArticle(html, ARTICLE_URL, ARTICLE_DATE, ARTICLE_TITLE);
    const ship = report.vessels.find((v) => v.hullNumber === 'CVN-78');
    assert.equal(ship.region, 'Caribbean');
    assert.equal(ship.regionLat, 15.0);
    assert.equal(ship.regionLon, -73.0);
    assert.deepEqual(report.parsingWarnings, []);
  });

  it('leaves a region in no table at the 0,0 sentinel', () => {
    // The bidirectional match must not turn every unknown name into a
    // coincidental substring hit. "Mystery Theater" has no table entry in
    // either direction and must still report as unplaced.
    const html = [
      '<h2>In the Mystery Theater</h2>',
      '<h3>Some Group</h3>',
      '<p>USS Nowhere (DDG-999) is underway.</p>',
    ].join('');
    const report = usniParseArticle(html, ARTICLE_URL, ARTICLE_DATE, ARTICLE_TITLE);
    const ship = report.vessels.find((v) => v.hullNumber === 'DDG-999');
    assert.equal(ship.regionLat, 0);
    assert.equal(ship.regionLon, 0);
    assert.deepEqual(report.parsingWarnings, ['Unknown region: "Mystery Theater"']);
  });

  it('prefers the longest key when several match', () => {
    // "Eastern Mediterranean" contains "Mediterranean Sea"? No. But
    // "Mediterranean" is a substring of both "Mediterranean Sea" and
    // "Eastern Mediterranean", and the bare name must not silently pick
    // whichever the table happens to list first.
    assert.deepEqual(usniGetRegionCoords('Eastern Mediterranean'), { lat: 34.5, lon: 33.0 });
  });
});
