import { readFileSync } from 'node:fs';
import { GameConnection } from '../dist/cdp.mjs';

const [tool, argument] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node scripts/live.mjs <tool> [json|@file]');
  process.exit(2);
}
const query = !argument ? {} : argument.startsWith('@')
  ? JSON.parse(readFileSync(argument.slice(1), 'utf8'))
  : JSON.parse(argument);

const game = new GameConnection('write');
let code = 0;
try {
  const { response } = await game.dispatch({ tool, query, view: 'live' });
  if (response.image) {
    console.log(JSON.stringify({
      data: response.data, fault: response.fault,
      imageBytes: Buffer.from(response.image, 'base64').length,
      imagePrefix: response.image.slice(0, 40),
    }, null, 2));
  } else {
    console.log(JSON.stringify(response, null, 2));
  }
} catch (error) {
  console.error('ERROR', error?.code ?? error?.message ?? String(error));
  code = 1;
} finally {
  game.close();
}
process.exit(code);
