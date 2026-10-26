import neo4j from 'neo4j-driver';

const { isInt, isNode, isRelationship, isPath, isPathSegment } = neo4j;

export const toPlain = (value) => {
  if (value === null || value === undefined) return null;
  if (isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (isNode(value)) return nodeToPlain(value);
  if (isRelationship(value)) return relToPlain(value);
  if (isPath(value)) {
    return {
      start: nodeToPlain(value.start),
      end: nodeToPlain(value.end),
      segments: value.segments.map(toPlain),
    };
  }
  if (isPathSegment(value)) {
    return {
      start: nodeToPlain(value.start),
      relationship: relToPlain(value.relationship),
      end: nodeToPlain(value.end),
    };
  }
  if (typeof value === 'object') {
    if (typeof value.toString === 'function' && value.constructor && value.constructor.name !== 'Object') {
      return value.toString();
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
};

const propsToPlain = (props) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toPlain(v)]));

export const nodeToPlain = (node) => ({
  id: node.elementId,
  labels: node.labels,
  properties: propsToPlain(node.properties),
});

export const relToPlain = (rel) => ({
  id: rel.elementId,
  type: rel.type,
  from: rel.startNodeElementId,
  to: rel.endNodeElementId,
  properties: propsToPlain(rel.properties),
});

export const collectGraph = (records) => {
  const nodes = new Map();
  const rels = new Map();

  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (isNode(value)) {
      if (!nodes.has(value.elementId)) nodes.set(value.elementId, nodeToPlain(value));
      return;
    }
    if (isRelationship(value)) {
      if (!rels.has(value.elementId)) rels.set(value.elementId, relToPlain(value));
      return;
    }
    if (isPath(value)) {
      visit(value.start);
      visit(value.end);
      value.segments.forEach(visit);
      return;
    }
    if (isPathSegment(value)) {
      visit(value.start);
      visit(value.relationship);
      visit(value.end);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && !isInt(value)) {
      Object.values(value).forEach(visit);
    }
  };

  const rows = [];
  for (const record of records) {
    const row = {};
    for (const key of record.keys) {
      const value = record.get(key);
      visit(value);
      row[key] = toPlain(value);
    }
    rows.push(row);
  }

  // NVL cannot draw relationships whose endpoints were not returned.
  const relList = [...rels.values()].filter((r) => nodes.has(r.from) && nodes.has(r.to));

  return {
    nodes: [...nodes.values()],
    rels: relList,
    rows,
    columns: records.length > 0 ? records[0].keys : [],
  };
};
