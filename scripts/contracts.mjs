import { readFile, mkdir, writeFile } from 'node:fs/promises';

const blocks = JSON.parse(await readFile(new URL('./base-contracts.json', import.meta.url), 'utf8'));
const { $defs } = blocks.find(block => block.$defs);
const game = blocks.find(tool => tool.name === 'game');
const props = game.inputSchema.properties;
const coord = { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
const tuple = (size) => ({ type: 'array', items: coord, minItems: size, maxItems: size });
const point = { anyOf: [tuple(2), { $ref: '#/$defs/Tile' }] };
const region = { anyOf: [tuple(4), { $ref: '#/$defs/Region' }] };
const layer = { enum: ['regular', 'wires'] };
const token = { type: 'string', minLength: 1, maxLength: 96 };
const list = (items, maxItems) => ({ type: 'array', items, minItems: 1, maxItems });
const publicOps = ['select', 'layer','view','waypoints','signals','check_signals','trace','save', 'hub', 'speeds', 'catalog', 'building', 'path', 'flow', 'place',
  'remove', 'route', 'wire', 'blueprint', 'upgrade', 'configure'];
props.op.enum = publicOps;
Object.assign(props,{requestId:{$ref:'#/$defs/RequestId'},reference:point,
  pin:{type:'integer',minimum:0,maximum:15},referencePin:{type:'integer',minimum:0,maximum:15},
  network:{type:'integer',minimum:0}});
for(const tool of blocks.filter(t=>['entities','resources'].includes(t.name))){
  for(const variant of tool.outputSchema.oneOf[0].properties.data.oneOf)
    if(variant.properties?.rows)variant.properties.restarted={const:true};
}
$defs.Receipt.properties.action.enum.push('game');
$defs.Receipt.properties.result={type:'object'};
delete $defs.Receipt.properties.completed.anyOf[0].maximum;

props.emptyOnly = { type: 'boolean' };
props.portable = { type: 'boolean' };
props.blueprint.items.properties.value = token;
delete props.code;
const status = blocks.find(tool => tool.name === 'status').outputSchema.oneOf[0].properties.data;
status.properties.layer = layer;
status.properties.selected = { type: 'boolean' };
status.properties.capabilities = { type:'array', items:{type:'string'} };
Object.assign(props, { region, at: point, layer, handle: token, targets: list(point, 64),
  color: { enum: ['first', 'second'] }, join: { type: 'boolean' }, value: token,
  rotation: { enum: [0, 90, 180, 270] } });
props.route.items = point;
props.tiles.items = point;
props.items.items.properties.at = point;
delete props.items.items.required;
props.items.items.oneOf = [{ properties: { x:coord, y:coord }, required: ['x','y'] },
  { properties: { at:point }, required: ['at'] }];
props.items.items.properties.x = coord;
props.items.items.properties.y = coord;
props.blueprint.items.properties.x = coord;
props.blueprint.items.properties.y = coord;
props.blueprint.items.properties.rotation = props.rotation;
props.items.items.properties.rotation = props.rotation;
props.items.items.properties.rotationVariant = { type: 'integer', minimum: 0, maximum: 3 };
for (const tool of blocks.filter(block => block.inputSchema)) {
  const p = tool.inputSchema.properties;
  if (p?.region) p.region = region;
  if (p?.points) p.points.items = point;
}
$defs.Op.properties.tile = point;
$defs.Fault.properties.code.enum.push('SIGNAL_REFERENCE_INVALID','CDP_TIMEOUT','SAVE_NOT_SELECTED','WIRE_CONTACT','BUILDING_LOCKED','BLUEPRINT_INVALID','BLUEPRINT_COST','ARGUMENT_INVALID');
blocks.push({ name: 'map_region', inputSchema: { type: 'object', required: ['region'], additionalProperties: false,
  properties: { region, layer: { enum: ['regular', 'wires', 'both'] }, format: { enum: ['rows', 'image'] } } },
  outputSchema: game.outputSchema });
const names = new Set(blocks.filter(block => block.inputSchema).map(block => block.name));

function schemaWithDefinitions(schema) {
  const definitions = {};
  function visit(object) {
    if (!object || typeof object !== 'object') return;
    if (object.$ref) {
      const key = object.$ref.match(/^#\/\$defs\/([A-Za-z]+)$/)?.[1];
      if (!key || !$defs[key]) throw new Error('Invalid schema reference');
      if (!definitions[key]) {
        definitions[key] = $defs[key];
        visit($defs[key]);
      }
    }
    for (const value of Object.values(object)) visit(value);
  }
  visit(schema);
  return { ...schema, $defs: definitions };
}

const tools = blocks.filter(block => names.has(block.name)).map(tool => ({
  name: tool.name,
  inputSchema: schemaWithDefinitions(tool.inputSchema),
  outputSchema: schemaWithDefinitions(tool.outputSchema),
}));
if (new Set(tools.map(tool => tool.name)).size !== names.size || tools.length !== names.size) {
  throw new Error('Incomplete or duplicate MCP tool contracts');
}
await mkdir('dist', { recursive: true });
await writeFile('dist/contracts.json', JSON.stringify(tools, null, 2) + '\n');
