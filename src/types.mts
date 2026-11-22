export type Point = { x: number; y: number };
export type Region = { x0: number; y0: number; x1: number; y1: number };
export type ToolName = 'status' | 'entities' | 'resources' | 'sample_flow' | 'screenshot' |
  'preview_belts' | 'apply_belts' | 'operation_status' | 'restore_snapshot' | 'game' | 'map_region';
export type QueryTool = 'entities' | 'resources';
export type Mode = 'observe' | 'write';
export type BeltDir = 'N' | 'E' | 'S' | 'W';
export type BeltOp = {
  op: 'place_straight' | 'replace_straight';
  tile: Point;
  to: BeltDir;
};
export type SnapshotTile = { x: number; y: number; code: number | null; rotation?: number };
export type BuildItem = {
  x: number; y: number; code?: number;
  building?: string;
  rotation?: number; rotationVariant?: number; variant?: string;
  direction?: BeltDir;
  from?: BeltDir;
  to?: BeltDir;
};
export type Query = {
  mode?: 'summary' | 'region' | 'page';
  limit?: number;
  cursor?: string;
  kind?: string;
  key?: string;
  region?: Region;
  points?: Point[];
  requestId?: string;
  op?: 'hub' | 'place' | 'remove' | 'upgrade' | 'catalog' | 'eval' |
    'speeds' | 'building' | 'flow' | 'path' | 'blueprint' | 'sample' |
    'preview' | 'applyBelts' | 'restoreTiles' | 'route' | 'wire' | 'select' | 'configure' | 'layer' | 'view' | 'waypoints' | 'signals' | 'trace' | 'check_signals' | 'save';
  pin?: number; reference?: Point; referencePin?: number; network?: number;
  at?: Point; targets?: Point[]; handle?: string; layer?: 'regular' | 'wires' | 'both';
  format?: 'rows' | 'image'; color?: 'first' | 'second'; join?: boolean;
  expected?: SnapshotTile[]; epoch?: string; value?: string; rotation?: number;
  blueprintMode?: 'capture' | 'paste';
  portable?: boolean; emptyOnly?: boolean;
  blueprint?: { value?: string; code: number; x: number; y: number; rotation?: number }[];
  dx?: number;
  dy?: number;
  seconds?: number;
  samples?: number;
  ops?: BeltOp[];
  route?: Point[];
  routeCode?: number;
  snapshotTiles?: SnapshotTile[];
  plan?: string;
  snapshot?: string;
  applyRequestId?: string;
  items?: BuildItem[];
  tiles?: Point[];
  id?: string;
  code?: string;
};
export type Position = { view: string; offset: number };
export type Command = {
  tool: ToolName;
  query: Query;
  view: string;
  position?: Position;
  previousConnection?: boolean; saveId?: string; journalKey?: string; selectedSaveId?: string; lookup?: boolean;
};
export type Result = {
  saveId?: string; image?: string;
  data?: Record<string, unknown>;
  fault?: string;
  inGame?: boolean | null;
  position?: Position;
};
