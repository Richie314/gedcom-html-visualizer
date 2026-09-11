import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import $ from 'jquery';

let renderer;
let camera;
let scene;
let controls;
let raycaster;
let pointer;
let interactive = [];
let selectedRoot;

/**
 * Assigns each person a signed generation level relative to the root.
 * Parents are one level above (-1), and children are one level below (+1).
 *
 * The traversal uses an auxiliary adjacency map because marriage connectors
 * sit between people in the rendered graph but are not themselves generations.
 * People that are disconnected from the root remain at level 0.
 */
function generationLevels(graph, rootId) {
  const levels = new Map([[rootId, 0]]);
  const familyLinks = new Map();
  const addLink = (from, to, direction) => {
    const links = familyLinks.get(from) || [];
    links.push([to, direction]);
    familyLinks.set(from, links);
  };

  // Convert each family into direct person-to-person generation edges.
  graph.connectors.forEach((connector) => connector.parents.forEach((parentId) => connector.children.forEach((childId) => {
    addLink(parentId, childId, 1);
    addLink(childId, parentId, -1);
  })));
  graph.links.filter((link) => link.type === 'parenthood').forEach((link) => {
    addLink(link.from, link.to, 1);
    addLink(link.to, link.from, -1);
  });
  
  // Breadth-first traversal assigns the first reachable level to each person.
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    familyLinks.get(id)?.forEach(([linkedId, direction]) => {
      if (levels.has(linkedId)) 
        return;
      levels.set(linkedId, levels.get(id) + direction);
      queue.push(linkedId);
    });
  }
  
  graph.people.forEach((person) => { 
    if (!levels.has(person.id)) 
      levels.set(person.id, 0); 
  });
  return levels;
}

/**
 * Creates a camera-facing label from a canvas texture.
 *
 * `lines` can be plain text, an array of lines, or a person object with
 * givenName, surname, name, and detail fields. Canvas text keeps labels crisp
 * while allowing the same sprite-based rendering approach for every node.
 */
function labelSprite(lines, color = '#ffffff', dataType = '?', compact = false) {
  const background = compact
    ? dataType === 'marriage' ? 'rgba(121,77,24,.92)' : 'rgba(72,59,126,.92)'
    : 'rgba(20,30,52,.92)';

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const personLabel = !Array.isArray(lines) && typeof lines === 'object';
  const labelLines = personLabel ? [lines.name, lines.detail].filter(Boolean) : (Array.isArray(lines) ? lines.filter(Boolean) : [lines]);
  const titleSize = compact ? 21 : 26;
  const detailSize = 18;
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  const width = Math.max(compact ? 120 : 180, Math.min(480, Math.max(...labelLines.map((line) => context.measureText(line).width)) + 30));
  canvas.width = width;
  canvas.height = labelLines.length > 1 ? 76 : 52;
  context.fillStyle = background;
  context.roundRect(0, 0, width, canvas.height, 12);
  context.fill();
  context.fillStyle = color;
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  
  if (personLabel && lines.surname) {
    const prefix = `${lines.givenName} `;
    context.fillText(prefix, 15, compact ? 29 : 31);
    const prefixWidth = context.measureText(prefix).width;
    context.font = `italic 600 ${titleSize}px system-ui, sans-serif`;
    context.fillText(lines.surname, 15 + prefixWidth, compact ? 29 : 31);
  } else {
    context.fillText(labelLines[0], 15, compact ? 29 : 31);
  }
  
  if (labelLines[1]) {
    context.fillStyle = '#c7d2ee';
    context.font = `400 ${detailSize}px system-ui, sans-serif`;
    context.fillText(labelLines[1], 15, 58);
  }

  // Create sprite and material
  const material = new THREE.SpriteMaterial({ 
    map: new THREE.CanvasTexture(canvas), // texture instead of geometry so labels always face the camera
    transparent: true, 
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width / 110, canvas.height / 110, 1);
  return sprite;
}

function generatePositions(graph) {
  const rootId = selectedRoot || graph.people.keys().next().value;

  // Divide the graph into generations based on the root person
  const levels = generationLevels(graph, rootId);
  
  // Group people by their generation level
  const grouped = new Map();
  levels.forEach((level, id) => {
    if (!grouped.has(level)) 
      grouped.set(level, []);
    grouped.get(level).push(id);
  });

  const branches = new Map([[rootId, 0]]);
  const assignBranch = (id, branch) => {
    if (branches.has(id)) return;
    branches.set(id, branch);
    graph.links.filter((link) => link.to === id).forEach((link) => assignBranch(link.from, branch));
    graph.connectors.forEach((connector) => {
      if (connector.children.includes(id)) connector.parents.forEach((parentId) => assignBranch(parentId, branch));
    });
  };
  graph.connectors.forEach((connector) => {
    if (connector.children.includes(rootId)) connector.parents.forEach((id) => {
      assignBranch(id, graph.people.get(id)?.sex === 'F' ? 1 : -1);
    });
  });
  graph.links.filter((link) => link.type === 'parenthood' && link.to === rootId).forEach((link) => {
    assignBranch(link.from, graph.people.get(link.from)?.sex === 'F' ? 1 : -1);
  });
  graph.people.forEach((person, id) => {
    const level = levels.get(id);
    const members = grouped.get(level);
    members.sort((first, second) => (branches.get(first) || 0) - (branches.get(second) || 0));
    const index = members.indexOf(id);
    person.position = new THREE.Vector3(
      (index - (members.length - 1) / 2) * 4.8,
      -level * 4.6,
      (branches.get(id) || 0) * 4.5,
    );
  });
  graph.connectors.forEach((connector, connectorIndex) => {
    const parentPositions = connector.parents.map((id) => graph.people.get(id)?.position).filter(Boolean);
    const childPositions = connector.children.map((id) => graph.people.get(id)?.position).filter(Boolean);
    const touchedPositions = [...parentPositions, ...childPositions];
    const level = connector.parents.length
      ? Math.max(...connector.parents.map((id) => levels.get(id) ?? 0))
      : Math.max(0, ...connector.children.map((id) => (levels.get(id) ?? 1) - 1));
    const average = touchedPositions.length
      ? touchedPositions.reduce((total, position) => total.add(position.clone()), new THREE.Vector3()).multiplyScalar(1 / touchedPositions.length)
      : new THREE.Vector3();
    const parentMidpoint = parentPositions.length
      ? parentPositions.reduce((total, position) => total.add(position.clone()), new THREE.Vector3()).multiplyScalar(1 / parentPositions.length)
      : null;
    connector.position = parentMidpoint || new THREE.Vector3(average.x, -level * 4.6, average.z - 1.4);
  });
  return { levels, grouped };
}

function getAppropriateGeometry(data, connector) {

  // Marriage link
  if (connector && data.type === 'marriage') 
    return new THREE.SphereGeometry(.32, 20, 14);
  
  // Parenthood link
  if (connector) 
    return new THREE.OctahedronGeometry(.4, 0);
  
  // Person node
  if (data.sex === 'F') 
    return new THREE.SphereGeometry(.58, 20, 14);
  if (data.sex === 'M') 
    return new THREE.BoxGeometry(1, 1, 1);
  
  // Unknown sex
  return new RoundedBoxGeometry(1, 1, 1, 4, .16);
}

function addNode(position, color, label, data, connector = false) {
  // Determine the appropriate geometry based on the node type
  // and create a material for the node
  const geometry = getAppropriateGeometry(data, connector);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: .35,
    metalness: .1,
    side: THREE.DoubleSide,
  });

  // Create the mesh from the geometry and material
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.userData = data;
  scene.add(mesh);
  interactive.push(mesh);

  const labelSpriteNode = labelSprite(label, '#fff', data.type, connector);
  labelSpriteNode.position.copy(position).add(new THREE.Vector3(0, connector ? .68 : 1, 0));
  scene.add(labelSpriteNode);
}

function addLink(from, to, color, radius) {
  const distance = from.distanceTo(to);
  const midpoint = from.clone().add(to).multiplyScalar(.5);

  const geometry = new THREE.CylinderGeometry(radius, radius, distance, 10);
  const material = new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: true });

  const line = new THREE.Mesh(geometry, material);
  line.position.copy(midpoint);
  line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  line.renderOrder = 1;
  scene.add(line);
}

export function renderGraph(graph) {
  selectedRoot = graph.rootId;
  interactive = [];
  scene.clear();
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const graphLight = new THREE.DirectionalLight(0xffffff, 2.4);
  graphLight.position.set(5, 10, 12);
  scene.add(graphLight);
  const { grouped } = generatePositions(graph);
  const linkMaterial = new THREE.LineBasicMaterial({ color: 0x53627f, transparent: true, opacity: .7 });
  const siblingMaterial = new THREE.LineDashedMaterial({ color: 0x91a0c0, transparent: true, opacity: .8, dashSize: .25, gapSize: .18 });
  graph.links.forEach((link) => {
    const from = graph.people.get(link.from)?.position || graph.connectors.get(link.from)?.position;
    const to = graph.people.get(link.to)?.position || graph.connectors.get(link.to)?.position;
    if (!from || !to) return;
    const color = link.type === 'parent' ? 0xd83b45 : 0xf28c28;
    if (link.type === 'parent' || link.type === 'child' || link.type === 'parenthood') {
      addLink(from, to, color, link.type === 'parenthood' ? .06 : .08);
    }
    else scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), linkMaterial));
  });
  graph.connectors.forEach((connector) => {
    for (let index = 0; index < connector.children.length; index += 1) {
      for (let siblingIndex = index + 1; siblingIndex < connector.children.length; siblingIndex += 1) {
        const first = graph.people.get(connector.children[index])?.position;
        const second = graph.people.get(connector.children[siblingIndex])?.position;
        if (!first || !second) continue;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([first, second]), siblingMaterial);
        line.computeLineDistances();
        scene.add(line);
      }
    }
  });
  graph.people.forEach((person) => {
    const color = person.sex === 'F' ? 0xef82ae : person.sex === 'M' ? 0x7195ff : 0x82d9a1;
    const years = [String(person.birth || '').match(/\b\d{3,4}\b/)?.[0], String(person.death || '').match(/\b\d{3,4}\b/)?.[0]].filter(Boolean);
    addNode(person.position, color, { givenName: person.givenName, surname: person.surname, name: person.name, detail: years.join(' – ') }, { ...person, kind: 'person' });
  });
  graph.connectors.forEach((connector) => addNode(connector.position, connector.type === 'marriage' ? 0xd83b45 : 0xf2b35d, connector.label, { ...connector, kind: 'connector' }, true));
  $('#peopleCount').text(graph.people.size);
  $('#familyCount').text(graph.connectors.size);
  $('#connectionCount').text(graph.links.length);
  $('#generationCount').text(grouped.size || 0);
  if (graph.people.size) {
    const graphSpan = Math.max(16, ...[...graph.people.values()].map((person) => Math.max(Math.abs(person.position.x), Math.abs(person.position.z)) * 1.8));
    controls.target.set(0, -(Math.max(0, grouped.size - 1) * 2), 0);
    camera.position.set(0, -Math.max(0, grouped.size - 1) * 1.5, Math.max(graphSpan, grouped.size * 4.6));
    controls.update();
  }
}

function moveView(direction, distance) {
  const offset = direction.clone().multiplyScalar(distance);
  camera.position.add(offset);
  controls.target.add(offset);
}

/**
 * Keyboard navigation directions mapped to normalized 3D vectors.
 */
const directions = {
  arrowleft: new THREE.Vector3(-1, 0, 0), 
  a: new THREE.Vector3(-1, 0, 0),
  
  arrowright: new THREE.Vector3(1, 0, 0), 
  d: new THREE.Vector3(1, 0, 0),
  
  arrowup: new THREE.Vector3(0, 1, 0), 
  w: new THREE.Vector3(0, 1, 0),
  
  arrowdown: new THREE.Vector3(0, -1, 0), 
  s: new THREE.Vector3(0, -1, 0),
  
  q: new THREE.Vector3(0, 0, -1), 
  e: new THREE.Vector3(0, 0, 1),
};

function handleKeyboardNavigation(event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) 
    return;
  
  const direction = directions[event.key.toLowerCase()];
  if (!direction) 
    return;
  
  event.preventDefault();
  moveView(direction, event.shiftKey ? 2.4 : 0.8);
}

export function initRenderer(onSelect) {
  const canvas = $('#scene')[0];
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x10182b);

  // Scene and camera creation
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, .1, 1000);
  camera.position.set(0, 0, 24);
  
  // Orbit controls and keyboard navigation
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 5;
  controls.maxDistance = 120;
  $(window).on('keydown', handleKeyboardNavigation);
  
  // Scene lights
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(5, 10, 12);
  scene.add(light);
  raycaster = new THREE.Raycaster();
  
  pointer = new THREE.Vector2();
  $(canvas).on('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    onSelect(raycaster.intersectObjects(interactive)[0]?.object.userData);
  });
  
  // Handle window resize
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  };
  $(window).on('resize', resize);
  resize();
  
  // Render loop
  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();
}
