import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import $ from 'jquery';
import { GEDCStruct, g5ConfGEDC } from 'js-gedcom';

const $uploadZone = $('#uploadZone');
const $fileInput = $('#fileInput');
const $fileMessage = $('#fileMessage');
const $detailPanel = $('#detailPanel');
let currentGraph = { 
  people: new Map(), 
  connectors: new Map(), 
  events: new Map(), 
  links: [],
};
let renderer, camera, scene, controls, raycaster, pointer;
let interactive = [];

function child(record, tag) {
  return record.sub.find((entry) => entry.tag === tag);
}

function children(record, tag) {
  return record.sub.filter((entry) => entry.tag === tag);
}

function eventDate(record, eventTag) {
  const event = child(record, eventTag);
  return event ? child(event, 'DATE')?.payload || '' : '';
}

function pointerId(record) {
  return record?.xref_id || '';
}

function nameParts(record) {
  const raw = String(record ? child(record, 'NAME')?.payload || 'Unknown person' : 'Unknown person');
  const surnameMatch = raw.match(/\/(.*?)\//);
  const surname = surnameMatch?.[1]?.trim() || '';
  const givenName = raw.replace(/\/(.*?)\//g, '').replace(/\s+/g, ' ').trim();
  
  return { 
    givenName, 
    surname, 
    name: [givenName, surname].filter(Boolean).join(' ')
  };
}

function parseGedcom(text) {
  const errors = [];
  const records = GEDCStruct.fromString(text, g5ConfGEDC, (message) => errors.push(message));
  const people = new Map();
  const connectors = new Map();
  const events = new Map();
  const parenthoodLinks = [];

  records.filter((record) => record.tag === 'INDI').forEach((record) => {
    const id = pointerId(record);
    people.set(id, {
      id,
      ...nameParts(record),
      sex: child(record, 'SEX')?.payload || '?',
      birth: eventDate(record, 'BIRT'),
      death: eventDate(record, 'DEAT'),
      families: [
        ...children(record, 'FAMS'), 
        ...children(record, 'FAMC')
      ].map((entry) => pointerId(entry.payload)),
      record,
    });
  });

  records.filter((record) => record.tag === 'FAM').forEach((record) => {
    const id = pointerId(record);
    const marriageDate = eventDate(record, 'MARR');
    const parents = [
      child(record, 'HUSB')?.payload, 
      child(record, 'WIFE')?.payload,
    ].map(pointerId).filter((personId) => people.has(personId));
    
    const childIds = children(record, 'CHIL').map((entry) => pointerId(entry.payload))
      .filter((personId) => people.has(personId));

    if (marriageDate || child(record, 'MARR')) {
      connectors.set(id, { id, type: 'marriage', parents, children: childIds, date: marriageDate, label: 'Marriage', record });
    } else {
      childIds.forEach((childId) => parents.forEach((parentId) => parenthoodLinks.push({
        from: parentId, to: childId, type: 'parenthood'
      })));
    }
  });

  const allowedMarriageChildren = new Set();
  connectors.forEach((connector) => {
    connector.children = connector.children.filter((childId) => {
      if (allowedMarriageChildren.has(childId)) 
        return false;
      
      allowedMarriageChildren.add(childId);
      return true;
    });
  });

  const links = [];
  connectors.forEach((connector) => {
    connector.parents.forEach((personId) => links.push({ 
      from: personId, 
      to: connector.id, 
      type: 'parent', 
    }));
    connector.children.forEach((personId) => links.push({ 
      from: connector.id, 
      to: personId, 
      type: 'child',
    }));
  });

  const allowedParenthoodParents = new Map();
  const filteredParenthoodLinks = parenthoodLinks.filter((link) => {
    if (allowedMarriageChildren.has(link.to)) 
      return false;
    
    const parents = allowedParenthoodParents.get(link.to) || new Set();
    if (parents.has(link.from) || parents.size >= 2) 
      return false;

    parents.add(link.from);
    allowedParenthoodParents.set(link.to, parents);

    return true;
  });


  people.forEach((person) => {
    person.record.sub.filter((entry) => [
      'BIRT', 'DEAT', 'BAPM', 
      'CHR', 'BURI', 'RESI', 
      'OCCU', 'EDUC', 'EMIG', 
      'IMMI', 'NOTE'
    ].includes(entry.tag))
      .forEach((entry, index) => events.set(`${person.id}:${entry.tag}:${index}`, {
        id: `${person.id}:${entry.tag}:${index}`, 
        tag: entry.tag, 
        record: entry, 
        personId: person.id,
      }));
  });

  return { 
    people, 
    connectors, 
    events, 
    links: [...links, ...filteredParenthoodLinks], 
    errors,
   };
}

function generationLevels(graph) {
  const levels = new Map([...graph.people.keys()].map((id) => [id, 0]));
  let changed = true;

  for (let round = 0; round < graph.people.size * 2 && changed; round++) {
    changed = false;
    graph.connectors.forEach((connector) => {
      const parentLevel = Math.max(
        0,
        ...connector.parents.map((id) => levels.get(id) ?? 0),
      );
      connector.parents.forEach((id) => {
        if (levels.get(id) < parentLevel) {
          levels.set(id, parentLevel);
          changed = true;
        }
      });
      connector.children.forEach((id) => {
        if (levels.get(id) < parentLevel + 1) {
          levels.set(id, parentLevel + 1);
          changed = true;
        }
      });
    });

    graph.links.filter((link) => link.type === 'parenthood').forEach((link) => {
      const parentLevel = levels.get(link.from) ?? 0;
      if (levels.get(link.to) < parentLevel + 1) {
        levels.set(link.to, parentLevel + 1);
        changed = true;
      }
    });
  }
  return levels;
}

function extractYear(value) {
  return String(value || '').match(/\b\d{3,4}\b/)?.[0] || '';
}

function labelSprite(lines, color = '#ffffff', background = 'rgba(20,30,52,.9)', compact = false) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const personLabel = !Array.isArray(lines) && typeof lines === 'object';
  const labelLines = personLabel ? [lines.name, lines.detail].filter(Boolean) : (Array.isArray(lines) ? lines.filter(Boolean) : [lines]);
  const titleSize = compact ? 21 : 26;
  const detailSize = 18;
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  
  const width = Math.max(
    compact ? 120 : 180, 
    Math.min(480, Math.max(...labelLines.map((line) => context.measureText(line).width)) + 30),
  );
  canvas.width = width; canvas.height = labelLines.length > 1 ? 76 : 52;
  
  context.fillStyle = background; context.roundRect(0, 0, width, canvas.height, 12);
  context.fill();
  context.fillStyle = color; context.font = `600 ${titleSize}px system-ui, sans-serif`;
  
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
    context.fillStyle = '#c7d2ee'; context.font = `400 ${detailSize}px system-ui, sans-serif`;
    context.fillText(labelLines[1], 15, 58);
  }

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ 
    map: new THREE.CanvasTexture(canvas), 
    transparent: true, 
    depthTest: false,
  }));
  sprite.scale.set(width / 110, canvas.height / 110, 1);
  return sprite;
}

function recordRows(record, depth = 0) {
  if (!record) 
    return '';
  
  const payload = record.payload;
  const value = payload && typeof payload === 'object'
    ? `<button class="btn btn-sm btn-link p-0 align-baseline inspector-link" data-inspect-id="${$('<div>').text(pointerId(payload)).html()}">${$('<div>').text(pointerId(payload)).html()}</button>`
    : $('<div>').text(payload ?? '').html();
  
  const row = `<div class="gedcom-row" style="--depth:${depth}"><code>${$('<div>').text(record.tag).html()}</code><span>${value}</span></div>`;
  return row + record.sub.map((entry) => recordRows(entry, depth + 1)).join('');
}

function linkedButtons(item) {
  const linked = [];

  if (item.kind === 'person') {
    item.families.filter((id) => currentGraph.connectors.has(id)).forEach((id) => linked.push(`<button class="btn btn-sm btn-outline-warning inspector-link" data-inspect-id="${id}">Marriage ${id}</button>`));
    currentGraph.events.forEach((event) => {
      if (event.personId === item.id) linked.push(`<button class="btn btn-sm btn-outline-secondary inspector-event" data-event-id="${event.id}">${event.tag}</button>`);
    });
  } else if (item.kind === 'connector') {
    [...item.parents, ...item.children].forEach((id) => linked.push(`<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${id}">${$('<div>').text(currentGraph.people.get(id)?.name || id).html()}</button>`));
  } else if (item.kind === 'event') {
    linked.push(`<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${item.personId}">${$('<div>').text(currentGraph.people.get(item.personId)?.name || item.personId).html()}</button>`);
  }
  return linked.length ? `<div class="mt-3"><div class="small text-muted mb-2">Linked records</div><div class="d-flex flex-wrap gap-2">${linked.join('')}</div></div>` : '';
}

function showDetails(item) {
  if (!item) 
    return;

  if (item.kind === 'event') {
    const eventTitle = child(item.record, 'DATE')?.payload || child(item.record, 'PLAC')?.payload || item.record.payload || item.tag;
    $detailPanel.html(`<div class="small text-primary fw-semibold mb-1">${$('<div>').text(item.tag).html()} EVENT</div><h3 class="h5 mb-3">${$('<div>').text(eventTitle).html()}</h3><div class="gedcom-rows">${recordRows(item.record)}</div>${linkedButtons(item)}`);
  } else if (item.kind === 'person') {
    const sexLabel = item.sex === 'F' ? 'WOMAN' : item.sex === 'M' ? 'MAN' : 'PERSON';
    $detailPanel.html(`<div class="d-flex justify-content-between gap-3"><div><div class="small text-primary fw-semibold mb-1">${sexLabel} · ${item.id}</div><h3 class="h5 mb-2">${$('<div>').text(item.givenName).html()} <em>${$('<div>').text(item.surname).html()}</em></h3></div><div class="fs-3">◉</div></div><div class="gedcom-rows mt-3">${recordRows(item.record)}</div>${linkedButtons(item)}`);
  } else {
    $detailPanel.html(`<div class="small text-warning-emphasis fw-semibold mb-1">MARRIAGE · ${item.id}</div><h3 class="h5 mb-3">${item.date ? `Married ${$('<div>').text(item.date).html()}` : 'Marriage'}</h3><div class="gedcom-rows">${recordRows(item.record)}</div>${linkedButtons(item)}`);
  }
}

function generationPositions(graph) {
  const levels = generationLevels(graph);
  const grouped = new Map();
  
  levels.forEach((level, id) => { 
    if (!grouped.has(level)) 
      grouped.set(level, []); 
    grouped.get(level).push(id); 
  });
  
  graph.people.forEach((person, id) => {
    const level = levels.get(id);
    const members = grouped.get(level);
    const index = members.indexOf(id);
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const rows = Math.ceil(members.length / columns);
    const column = index % columns;
    const row = Math.floor(index / columns);

    person.position = new THREE.Vector3(
      (column - (columns - 1) / 2) * 4.8,
      -level * 4.6,
      (row - (rows - 1) / 2) * 3.8,
    );
  });

  graph.connectors.forEach((connector, connectorIndex) => {
    const parentPositions = connector.parents
      .map((id) => graph.people.get(id)?.position)
      .filter(Boolean);
    const childPositions = connector.children
      .map((id) => graph.people.get(id)?.position)
      .filter(Boolean);
    const touchedPositions = [...parentPositions, ...childPositions];
    const level = connector.parents.length
      ? Math.max(...connector.parents.map((id) => levels.get(id) ?? 0))
      : Math.max(0, ...connector.children.map((id) => (levels.get(id) ?? 1) - 1));
    const average = touchedPositions.length
      ? touchedPositions.reduce(
        (total, position) => total.add(position.clone()),
        new THREE.Vector3(),
      ).multiplyScalar(1 / touchedPositions.length)
      : new THREE.Vector3();

    connector.level = level;
    connector.position = new THREE.Vector3(
      average.x,
      -level * 4.6,
      average.z + 1.4 + (connectorIndex % 3) * 0.45,
    );

    if (!parentPositions.length && childPositions.length) {
      connector.position.z = average.z - 1.4;
    }
  });
  return { levels, grouped };
}

function buildGraph(graph) {
  currentGraph = graph; interactive = [];
  scene.clear();
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));

  const graphLight = new THREE.DirectionalLight(0xffffff, 2.4);
  graphLight.position.set(5, 10, 12); scene.add(graphLight);
  
  const { levels, grouped } = generationPositions(graph);
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
 });
  
  graph.links.forEach((link) => {
    const from = graph.people.get(link.from)?.position || graph.connectors.get(link.from)?.position;
    const to = graph.people.get(link.to)?.position || graph.connectors.get(link.to)?.position;
    if (from && to) {
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), linkMaterial));
    }
  });

  graph.connectors.forEach((connector) => {
    for (let index = 0; index < connector.children.length; index += 1) {
      for (let siblingIndex = index + 1; siblingIndex < connector.children.length; siblingIndex += 1) {
        const first = graph.people.get(connector.children[index])?.position;
        const second = graph.people.get(connector.children[siblingIndex])?.position;
        if (!first || !second) 
          continue;
        
        const line = new THREE.Line(
          new THREE.BufferGeometry()
            .setFromPoints([first, second]), 
          siblingMaterial,
        );
        line.computeLineDistances();
        scene.add(line);
      }
    }
  });

  graph.people.forEach((person) => {
    const color = person.sex === 'F' ? 0xef82ae : person.sex === 'M' ? 0x7195ff : 0x9ba8c1;
    const years = [extractYear(person.birth), extractYear(person.death)].filter(Boolean);
    addNode(
      person.position, 
      color, 
      { 
        givenName: person.givenName, 
        surname: person.surname, 
        name: person.name, 
        detail: years.join(' – ') 
      },
      { 
        ...person, 
        kind: 'person',
      },
    );
  });

  graph.connectors.forEach((connector) => {
    const color = 0xf2b35d;
    addNode(
      connector.position, 
      color, 
      connector.label, 
      { 
        ...connector, 
        kind: 'connector',
      },
      true,
    );
  });

  $('#peopleCount').text(graph.people.size);
  $('#familyCount').text(graph.connectors.size);
  $('#connectionCount').text(graph.links.length);
  $('#generationCount').text(grouped.size || 0);
  
  if (graph.people.size) {
    const graphSpan = Math.max(
      16,
      ...[...graph.people.values()].map((person) => Math.max(
        Math.abs(person.position.x),
        Math.abs(person.position.z),
      ) * 1.8),
    );
    controls.target.set(0, -(Math.max(0, grouped.size - 1) * 2), 0);
    camera.position.set(
      0,
      -Math.max(0, grouped.size - 1) * 1.5,
      Math.max(graphSpan, grouped.size * 4.6),
    );
    controls.update();
  }
}

function addNode(position, color, label, data, connector = false) {
  const geometry = connector ? 
    new THREE.OctahedronGeometry(.4, 0) :
    new THREE.SphereGeometry(.58, 20, 14);

  const mesh = new THREE.Mesh(
    geometry, 
    new THREE.MeshStandardMaterial({ color, roughness: .35, metalness: .1 }),
  );
  mesh.position.copy(position);
  mesh.userData = data;
  scene.add(mesh);
  interactive.push(mesh);
  
  const labelBackground = connector
    ? data.type === 'marriage' ? 'rgba(121,77,24,.92)' : 'rgba(72,59,126,.92)'
    : 'rgba(20,30,52,.92)';
  const labelSpriteNode = labelSprite(label, '#fff', labelBackground, connector);
  labelSpriteNode.position.copy(position).add(new THREE.Vector3(0, connector ? .68 : 1, 0));
  scene.add(labelSpriteNode);
}

function moveView(direction, distance) {
  const offset = direction.clone().multiplyScalar(distance);
  camera.position.add(offset);
  controls.target.add(offset);
}

function handleKeyboardNavigation(event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    return;
  }

  const key = event.key.toLowerCase();
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
  const direction = directions[key];

  if (!direction) {
    return;
  }

  event.preventDefault();
  moveView(direction, event.shiftKey ? 2.4 : 0.8);
}

function initScene() {
  const canvas = $('#scene')[0];
  renderer = new THREE.WebGLRenderer({ 
    canvas, 
    antialias: true, 
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor(0x10182b);
  
  scene = new THREE.Scene();
  
  camera = new THREE.PerspectiveCamera(50, 1, .1, 1000);
  camera.position.set(0, 0, 24);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 5;
  controls.maxDistance = 120;
  window.addEventListener('keydown', handleKeyboardNavigation);
  
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
    showDetails(raycaster.intersectObjects(interactive)[0]?.object.userData);
  });

  const resize = () => { 
    const rect = canvas.getBoundingClientRect(); 
    renderer.setSize(rect.width, rect.height, false); 
    camera.aspect = rect.width / rect.height; 
    camera.updateProjectionMatrix(); 
  };
  $(window).on('resize', resize);
  resize();
  
  const animate = () => { 
    requestAnimationFrame(animate); 
    controls.update(); 
    renderer.render(scene, camera); 
  }; 
  animate();
}

function loadFile(file) {
  if (!file) 
    return;

  if (!/\.(ged|gedcom|txt)$/i.test(file.name)) { 
    $fileMessage.text('Please choose a .ged or .gedcom file.')
      .attr('class', 'small mt-2 text-center text-danger');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const graph = parseGedcom(String(reader.result));
      $fileMessage.text(`${file.name} loaded · ${graph.people.size} people found`)
        .attr('class', `small mt-2 text-center ${graph.errors.length ? 'text-warning' : 'text-success'}`);
      buildGraph(graph);
    } catch (error) {
      $fileMessage.text(`Could not parse the GEDCOM file: ${error.message}`)
        .attr('class', 'small mt-2 text-center text-danger');
    }
  };
  reader.onerror = () => $fileMessage.text('The file could not be read.')
    .attr('class', 'small mt-2 text-center text-danger');
  reader.readAsText(file);
}

$('#chooseButton').on('click', (event) => { event.stopPropagation(); $fileInput[0].click(); });
$fileInput.on('change', () => loadFile($fileInput[0].files[0]));
$uploadZone.on('click', (event) => {
  if (event.target !== $fileInput[0])
    $fileInput[0].click();
});

['dragenter', 'dragover'].forEach((eventName) => $uploadZone.on(eventName, (event) => {
  event.preventDefault();
  $uploadZone.addClass('dragging');
}));
['dragleave', 'drop'].forEach((eventName) => $uploadZone.on(eventName, (event) => {
  event.preventDefault();
  $uploadZone.removeClass('dragging');
}));

$uploadZone.on('drop', (event) => loadFile(event.originalEvent.dataTransfer.files[0]));
$detailPanel.on('click', '[data-inspect-id], [data-event-id]', (event) => {
  const $target = $(event.currentTarget);

  const item = $target.data('eventId')
    ? currentGraph.events.get($target.data('eventId'))
    : currentGraph.people.get($target.data('inspectId')) || currentGraph.connectors.get($target.data('inspectId'));
  showDetails(item ? { 
    ...item, 
    kind: $target.data('eventId') ? 'event' : item.kind || (currentGraph.people.has(item.id) ? 'person' : 'connector')
  } : null);
});
initScene();
