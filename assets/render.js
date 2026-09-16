import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import $ from 'jquery';
import { createPersonNode, createLink, createHeart, placeOnLineMiddle } from './shapes.js';

let renderer;
let camera;
let scene;
let controls;
let raycaster;
let pointer;
let interactive = [];
let selectedRoot;
let selectedPersonNode;

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
  improveFamilyLayout(graph, levels);
  return { levels, grouped };
}

function improveFamilyLayout(graph, levels) {
  const rowMembers = new Map();
  levels.forEach((level, personId) => {
    const members = rowMembers.get(level) || [];
    members.push(graph.people.get(personId));
    rowMembers.set(level, members);
  });

  const movePerson = (person, offset) => {
    if (person) person.position.x += offset;
  };

  // Keep each couple together and center their children below them.
  graph.connectors.forEach((connector) => {
    const parents = connector.parents.map((id) => graph.people.get(id)).filter(Boolean);
    const children = connector.children.map((id) => graph.people.get(id)).filter(Boolean);
    if (parents.length === 2) {
      const parentCenter = parents.reduce((total, parent) => total + parent.position.x, 0) / parents.length;
      const targetCenter = children.length
        ? children.reduce((total, child) => total + child.position.x, 0) / children.length
        : parentCenter;
      const halfGap = 1.2;
      movePerson(parents[0], targetCenter - halfGap - parents[0].position.x);
      movePerson(parents[1], targetCenter + halfGap - parents[1].position.x);
    }
  });

  // Prevent people on the same generation row from overlapping after alignment.
  rowMembers.forEach((members) => {
    members.sort((first, second) => first.position.x - second.position.x);
    for (let index = 1; index < members.length; index += 1) {
      const previous = members[index - 1];
      const current = members[index];
      const minimumX = previous.position.x + 3.2;
      if (current.position.x < minimumX) current.position.x = minimumX;
    }
  });

  const allPeople = [...graph.people.values()];
  const graphCenter = allPeople.reduce((total, person) => total + person.position.x, 0) / allPeople.length;
  allPeople.forEach((person) => { person.position.x -= graphCenter; });

  graph.connectors.forEach((connector) => {
    const parentPositions = connector.parents
      .map((id) => graph.people.get(id)?.position)
      .filter(Boolean);
    connector.position = parentPositions.length
      ? parentPositions.reduce(
        (total, position) => total.add(position.clone()),
        new THREE.Vector3(),
      ).multiplyScalar(1 / parentPositions.length)
      : connector.position;
  });
}

function focusCameraOnGraph(people) {
  const bounds = new THREE.Box3();
  people.forEach((person) => bounds.expandByPoint(person.position));

  const center = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const distance = Math.max(12, sphere.radius / Math.sin(verticalFov / 2) * 1.2);

  controls.target.copy(center);
  camera.position.set(center.x, center.y, center.z + distance);
  camera.near = Math.max(.1, distance / 1000);
  camera.far = Math.max(1000, distance * 4);
  camera.updateProjectionMatrix();
  controls.update();
}

function selectPersonNode(node) {
  if (selectedPersonNode) {
    selectedPersonNode.scale.setScalar(1);
    selectedPersonNode.material.emissiveIntensity = 0;
  }
  selectedPersonNode = node || null;
  if (selectedPersonNode) {
    selectedPersonNode.material.emissive.setHex(0xffffff);
  }
}


export function renderGraph(graph) {
  selectedRoot = graph.rootId;

  // Clear previous scene
  interactive = [];
  selectedPersonNode = null;
  scene.clear();

  // Add lights
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const graphLight = new THREE.DirectionalLight(0xffffff, 2.4);
  graphLight.position.set(5, 10, 12);
  scene.add(graphLight);

  const linkMaterial = new THREE.LineBasicMaterial({ 
    color: 0x53627f, 
    transparent: true, 
    opacity: .7,
  });
  const siblingMaterial = new THREE.LineDashedMaterial({ 
    color: 0x91a0c0, 
    transparent: true, 
    opacity: .8, 
    dashSize: .25, 
    gapSize: .18,
  }); // Special links to emphasize siblinghood
  
  const { grouped } = generatePositions(graph);

  // Draw links first so they appear behind nodes
  graph.links.forEach((link) => {
    const from = graph.people.get(link.from)?.position || graph.connectors.get(link.from)?.position;
    const to = graph.people.get(link.to)?.position || graph.connectors.get(link.to)?.position;
    if (!from || !to) 
      return;

    const color = link.type === 'parent' ? 0xd83b45 : 0xf28c28;
    if (['parent', 'child', 'parenthood'].includes(link.type)) {
      const linkMesh = createLink(from, to, color, link.type === 'parenthood' ? .06 : .08);
      scene.add(linkMesh);
    } else {
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      scene.add(new THREE.Line(geometry, linkMaterial));
    }
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

  // Draw nodes after links so they appear on top
  graph.people.forEach((person) => {
    const color = person.sex === 'F' ? 0xef82ae : person.sex === 'M' ? 0x7195ff : 0x82d9a1;
    const years = [String(person.birth || '').match(/\b\d{3,4}\b/)?.[0], String(person.death || '').match(/\b\d{3,4}\b/)?.[0]].filter(Boolean);
    
    const { personNode, labelSpriteNode } = createPersonNode(
      person.position, 
      color,
      {
        givenName: person.givenName,
        surname: person.surname,
        name: person.name,
        detail: years.join(' – '),
      },
      {
        ...person,
        kind: 'person',
      }
    );
    scene.add(personNode);
    interactive.push(personNode);
    scene.add(labelSpriteNode);
    if (person.id === selectedRoot) selectPersonNode(personNode);
  });

  // Add hearts to simbolize marriage
  graph.connectors.forEach(c => {
    const parent1 = graph.people.get(c.parents[0]);
    const parent2 = graph.people.get(c.parents[1]);
    if (!parent1 || !parent2) 
      return;

    const heart = createHeart();
    placeOnLineMiddle(heart, parent1.position, parent2.position);
    scene.add(heart);
  });
  
  
  $('#peopleCount').text(graph.people.size);
  $('#familyCount').text(graph.connectors.size);
  $('#connectionCount').text(graph.links.length);
  $('#generationCount').text(grouped.size || 0);
  if (graph.people.size) {
    focusCameraOnGraph(graph.people.values());
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
    const selected = raycaster.intersectObjects(interactive)[0]?.object;
    selectPersonNode(selected);
    onSelect(selected?.userData);
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
  const animate = (time) => {
    requestAnimationFrame(animate);
    controls.update();
    if (selectedPersonNode) {
      const pulse = (Math.sin(time * .004) + 1) / 2;
      selectedPersonNode.scale.setScalar(1 + pulse * .12);
      selectedPersonNode.material.emissiveIntensity = .25 + pulse * .4;
    }
    renderer.render(scene, camera);
  };
  animate();
}
