// Builds the world map the Traffic section draws its countries on (E109), once, from world-atlas's
// 110m country shapes: an Equal Earth projection turned into SVG path strings keyed by ISO 3166-1
// alpha-2 code, written to a checked-in JSON file. The app reads that file and needs no map library
// at run time. Run it again only to change the map:
//
//   node apps/desktop/scripts/build-world-map.mjs
//
// world-atlas, topojson-client and d3-geo are devDependencies for this script alone.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoEqualEarth, geoPath } from 'd3-geo';
import { feature, merge } from 'topojson-client';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const atlas = JSON.parse(
  readFileSync(join(desktop, 'node_modules/world-atlas/countries-110m.json'), 'utf-8'),
);
const OUT = join(desktop, 'src/renderer/src/components/deploy/traffic/worldMap.json');

const WIDTH = 960;
const HEIGHT = 470;

// ISO 3166-1 numeric to alpha-2, for every country in the 110m file. Antarctica is left out: it
// gets no visitors and would take a wide strip at the bottom.
const ALPHA2 = {
  '004': 'AF',
  '008': 'AL',
  '012': 'DZ',
  '024': 'AO',
  '031': 'AZ',
  '032': 'AR',
  '036': 'AU',
  '040': 'AT',
  '044': 'BS',
  '050': 'BD',
  '051': 'AM',
  '056': 'BE',
  '064': 'BT',
  '068': 'BO',
  '070': 'BA',
  '072': 'BW',
  '076': 'BR',
  '084': 'BZ',
  '090': 'SB',
  '096': 'BN',
  100: 'BG',
  104: 'MM',
  108: 'BI',
  112: 'BY',
  116: 'KH',
  120: 'CM',
  124: 'CA',
  140: 'CF',
  144: 'LK',
  148: 'TD',
  152: 'CL',
  156: 'CN',
  158: 'TW',
  170: 'CO',
  178: 'CG',
  180: 'CD',
  188: 'CR',
  191: 'HR',
  192: 'CU',
  196: 'CY',
  203: 'CZ',
  204: 'BJ',
  208: 'DK',
  214: 'DO',
  218: 'EC',
  222: 'SV',
  226: 'GQ',
  231: 'ET',
  232: 'ER',
  233: 'EE',
  238: 'FK',
  242: 'FJ',
  246: 'FI',
  250: 'FR',
  260: 'TF',
  262: 'DJ',
  266: 'GA',
  268: 'GE',
  270: 'GM',
  275: 'PS',
  276: 'DE',
  288: 'GH',
  300: 'GR',
  304: 'GL',
  320: 'GT',
  324: 'GN',
  328: 'GY',
  332: 'HT',
  340: 'HN',
  348: 'HU',
  352: 'IS',
  356: 'IN',
  360: 'ID',
  364: 'IR',
  368: 'IQ',
  372: 'IE',
  376: 'IL',
  380: 'IT',
  384: 'CI',
  388: 'JM',
  392: 'JP',
  398: 'KZ',
  400: 'JO',
  404: 'KE',
  408: 'KP',
  410: 'KR',
  414: 'KW',
  417: 'KG',
  418: 'LA',
  422: 'LB',
  426: 'LS',
  428: 'LV',
  430: 'LR',
  434: 'LY',
  440: 'LT',
  442: 'LU',
  450: 'MG',
  454: 'MW',
  458: 'MY',
  466: 'ML',
  478: 'MR',
  484: 'MX',
  496: 'MN',
  498: 'MD',
  499: 'ME',
  504: 'MA',
  508: 'MZ',
  512: 'OM',
  516: 'NA',
  524: 'NP',
  528: 'NL',
  540: 'NC',
  548: 'VU',
  554: 'NZ',
  558: 'NI',
  562: 'NE',
  566: 'NG',
  578: 'NO',
  586: 'PK',
  591: 'PA',
  598: 'PG',
  600: 'PY',
  604: 'PE',
  608: 'PH',
  616: 'PL',
  620: 'PT',
  624: 'GW',
  626: 'TL',
  630: 'PR',
  634: 'QA',
  642: 'RO',
  643: 'RU',
  646: 'RW',
  682: 'SA',
  686: 'SN',
  688: 'RS',
  694: 'SL',
  703: 'SK',
  704: 'VN',
  705: 'SI',
  706: 'SO',
  710: 'ZA',
  716: 'ZW',
  724: 'ES',
  728: 'SS',
  729: 'SD',
  732: 'EH',
  740: 'SR',
  748: 'SZ',
  752: 'SE',
  756: 'CH',
  760: 'SY',
  762: 'TJ',
  764: 'TH',
  768: 'TG',
  780: 'TT',
  784: 'AE',
  788: 'TN',
  792: 'TR',
  795: 'TM',
  800: 'UG',
  804: 'UA',
  807: 'MK',
  818: 'EG',
  826: 'GB',
  834: 'TZ',
  840: 'US',
  854: 'BF',
  858: 'UY',
  860: 'UZ',
  862: 'VE',
  887: 'YE',
  894: 'ZM',
};

// The shapes with no numeric code: Kosovo has its user-assigned code, and the two unrecognised
// territories are drawn as part of the country the address databases place them in.
const BY_NAME = { Kosovo: 'XK', 'N. Cyprus': 'CY', Somaliland: 'SO' };

const geometries = atlas.objects.countries.geometries;
const groups = new Map();
for (const geometry of geometries) {
  const code = geometry.id ? ALPHA2[geometry.id] : BY_NAME[geometry.properties.name];
  if (!code) {
    if (geometry.id !== '010') throw new Error(`No alpha-2 code for ${geometry.properties.name}`);
    continue;
  }
  groups.set(code, [...(groups.get(code) ?? []), geometry]);
}

const shapes = [...groups].map(([code, parts]) => ({
  type: 'Feature',
  id: code,
  properties: {},
  geometry: parts.length === 1 ? feature(atlas, parts[0]).geometry : merge(atlas, parts),
}));

const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], {
  type: 'FeatureCollection',
  features: shapes,
});
const path = geoPath(projection);

/** One decimal is a tenth of a pixel at full width, which no screen shows. */
function compact(d) {
  return d
    .replace(/-?\d+\.\d+/g, (number) => String(Math.round(Number(number) * 10) / 10))
    .replace(/,/g, ' ')
    .replace(/ -/g, '-');
}

const countries = {};
for (const shape of shapes.sort((a, b) => a.id.localeCompare(b.id))) {
  const d = path(shape);
  if (d) countries[shape.id] = compact(d);
}

// Two-space JSON with one country a line, the way the repo's formatter writes it.
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source:
        'world-atlas 2.0.2 countries-110m (Natural Earth, public domain), Equal Earth projection',
      width: WIDTH,
      height: HEIGHT,
      countries,
    },
    null,
    2,
  )}
`,
);
process.stdout.write(`Wrote ${Object.keys(countries).length} countries to ${OUT}\n`);
