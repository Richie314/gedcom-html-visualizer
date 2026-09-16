import $ from 'jquery';
import { GEDCStruct, g5ConfGEDC } from 'js-gedcom';

const $uploadZone = $('#uploadZone');
const $fileInput = $('#fileInput');
const $fileMessage = $('#fileMessage');
const $detailPanel = $('#detailPanel');
const $changeRootButton = $('#changeRootButton');
const $mainPersonSelect = $('#mainPersonSelect');
const mainPersonModal = new bootstrap.Modal('#mainPersonModal');
const relativesModal = new bootstrap.Modal('#relativesModal');
let currentGraph = { people: new Map(), connectors: new Map(), events: new Map(), links: [] };
let birthplaceMap;
const geocodeCache = new Map();

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

function eventPlace(record, eventTag) {
  const event = child(record, eventTag);
  return event ? child(event, 'PLAC')?.payload || '' : '';
}

function pointerId(record) {
  return record?.xref_id || '';
}

function nameParts(record) {
  const raw = String(record ? child(record, 'NAME')?.payload || 'Unknown person' : 'Unknown person');
  const surnameMatch = raw.match(/\/(.*?)\//);
  const surname = surnameMatch?.[1]?.trim() || '';
  const givenName = raw.replace(/\/(.*?)\//g, '').replace(/\s+/g, ' ').trim();
  return { givenName, surname, name: [givenName, surname].filter(Boolean).join(' ') };
}

export function parseGedcom(text) {
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
      birthPlace: eventPlace(record, 'BIRT'),
      death: eventDate(record, 'DEAT'),
      families: [...children(record, 'FAMS'), ...children(record, 'FAMC')].map((entry) => pointerId(entry.payload)),
      record,
    });
  });

  records.filter((record) => record.tag === 'FAM').forEach((record) => {
    const id = pointerId(record);
    const marriageDate = eventDate(record, 'MARR');
    const parents = [child(record, 'HUSB')?.payload, child(record, 'WIFE')?.payload]
      .map(pointerId).filter((personId) => people.has(personId));
    const childIds = children(record, 'CHIL').map((entry) => pointerId(entry.payload))
      .filter((personId) => people.has(personId));

    if (parents.length >= 2) {
      connectors.set(id, {
        id,
        type: 'marriage',
        parents,
        children: childIds,
        date: marriageDate,
        label: 'Marriage',
        record,
      });
    } else {
      childIds.forEach((childId) => parents.forEach((parentId) => parenthoodLinks.push({
        from: parentId, to: childId, type: 'parenthood',
      })));
    }
  });

  const allowedMarriageChildren = new Set();
  connectors.forEach((connector) => {
    connector.children = connector.children.filter((childId) => {
      if (allowedMarriageChildren.has(childId)) return false;
      allowedMarriageChildren.add(childId);
      return true;
    });
  });

  const links = [];
  connectors.forEach((connector) => {
    connector.parents.forEach((personId) => links.push({ from: personId, to: connector.id, type: 'parent' }));
    connector.children.forEach((personId) => links.push({ from: connector.id, to: personId, type: 'child' }));
  });

  const allowedParenthoodParents = new Map();
  const filteredParenthoodLinks = parenthoodLinks.filter((link) => {
    if (allowedMarriageChildren.has(link.to)) return false;
    const parents = allowedParenthoodParents.get(link.to) || new Set();
    if (parents.has(link.from) || parents.size >= 2) return false;
    parents.add(link.from);
    allowedParenthoodParents.set(link.to, parents);
    return true;
  });

  people.forEach((person) => {
    person.record.sub.filter((entry) => [
      'BIRT', 'DEAT', 'BAPM', 'CHR', 'BURI', 'RESI', 'OCCU', 'EDUC', 'EMIG', 'IMMI', 'NOTE',
    ].includes(entry.tag)).forEach((entry, index) => events.set(`${person.id}:${entry.tag}:${index}`, {
      id: `${person.id}:${entry.tag}:${index}`,
      tag: entry.tag,
      record: entry,
      personId: person.id,
    }));
  });

  return { people, connectors, events, links: [...links, ...filteredParenthoodLinks], errors };
}

function html(value) {
  return $('<div>').text(value ?? '').html();
}

function birthplaceMarker(person) {
  const sexClass = person.sex === 'F'
    ? 'birthplace-marker-female'
    : person.sex === 'M'
      ? 'birthplace-marker-male'
      : 'birthplace-marker-unknown';
  const shapeClass = person.sex === 'F'
    ? 'birthplace-marker-sphere'
    : person.sex === 'M'
      ? 'birthplace-marker-cube'
      : 'birthplace-marker-rounded-cube';
  return L.divIcon({
    className: 'birthplace-icon',
    html: `<span class="birthplace-marker ${sexClass} ${shapeClass}" aria-hidden="true"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

async function geocodePlace(place) {
  if (geocodeCache.has(place)) return geocodeCache.get(place);
  const query = encodeURIComponent(place);
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${query}`,
  );
  if (!response.ok) throw new Error(`Geocoding failed for ${place}`);
  const results = await response.json();
  const result = results[0]
    ? { lat: Number(results[0].lat), lon: Number(results[0].lon) }
    : null;
  geocodeCache.set(place, result);
  return result;
}

function initBirthplaceMap() {
  if (birthplaceMap || !document.querySelector('#birthplaceMap')) return;
  birthplaceMap = L.map('birthplaceMap', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(birthplaceMap);
  birthplaceMap.setView([20, 0], 2);
}

function clearBirthplaceLayers() {
  birthplaceMap.eachLayer((layer) => {
    if (!(layer instanceof L.TileLayer)) birthplaceMap.removeLayer(layer);
  });
}

async function renderBirthplaceMap(graph) {
  initBirthplaceMap();
  if (!birthplaceMap) return;
  clearBirthplaceLayers();

  const peopleWithPlaces = [...graph.people.values()]
    .filter((person) => String(person.birthPlace || '').trim());
  $('#birthplaceMapMessage').text(peopleWithPlaces.length
    ? 'Locating birth places...'
    : 'No birth places found in this GEDCOM file.');
  if (!peopleWithPlaces.length) return;

  const locations = new Map();
  for (const person of peopleWithPlaces) {
    if (!locations.has(person.birthPlace)) {
      try {
        locations.set(person.birthPlace, await geocodePlace(person.birthPlace));
      } catch {
        locations.set(person.birthPlace, null);
      }
    }
  }

  const coordinates = new Map();
  peopleWithPlaces.forEach((person) => {
    const location = locations.get(person.birthPlace);
    if (!location) return;
    const point = [location.lat, location.lon];
    coordinates.set(person.id, point);
    L.marker(point, { icon: birthplaceMarker(person) })
      .bindPopup(`<strong>${html(person.name)}</strong><br>${html(person.birth || 'Birth date unknown')}<br>${html(person.birthPlace)}`)
      .addTo(birthplaceMap);
  });

  const parenthoodConnections = new Map();
  const addParenthoodConnection = (from, to) => {
    if (!from || !to || from === to) return;
    parenthoodConnections.set(`${from}:${to}`, { from, to });
  };
  graph.links
    .filter((link) => link.type === 'parenthood')
    .forEach((link) => addParenthoodConnection(link.from, link.to));
  graph.connectors.forEach((connector) => {
    connector.parents.forEach((parentId) => {
      connector.children.forEach((childId) => addParenthoodConnection(parentId, childId));
    });
  });

  parenthoodConnections.forEach((link) => {
      const parentPoint = coordinates.get(link.from);
      const childPoint = coordinates.get(link.to);
      if (!parentPoint || !childPoint) return;
      const connection = L.polyline([parentPoint, childPoint], {
        color: '#f28c28',
        weight: 2,
        opacity: .8,
        dashArray: '6 5',
      });
      connection
        .bindTooltip(`${html(graph.people.get(link.from)?.name || link.from)} → ${html(graph.people.get(link.to)?.name || link.to)}`)
        .addTo(birthplaceMap);
      L.polylineDecorator(connection, {
        patterns: [{
          offset: '97%',
          repeat: 0,
          symbol: L.Symbol.arrowHead({
            pixelSize: 13,
            polygon: true,
            pathOptions: {
              color: '#f28c28',
              fillColor: '#f28c28',
              fillOpacity: 1,
              weight: 3,
              opacity: 1,
            },
          }),
        }],
      }).addTo(birthplaceMap);
    });

  const visiblePoints = [...coordinates.values()];
  if (visiblePoints.length === 1) {
    birthplaceMap.setView(visiblePoints[0], 8);
  } else if (visiblePoints.length > 1) {
    birthplaceMap.fitBounds(L.latLngBounds(visiblePoints), { padding: [24, 24] });
  }
  const unresolved = peopleWithPlaces.length - coordinates.size;
  $('#birthplaceMapMessage').text(unresolved
    ? `${coordinates.size} birth places shown; ${unresolved} could not be located.`
    : `${coordinates.size} birth places shown.`);
}

function recordRows(record, depth = 0) {
  if (!record) return '';
  const payload = record.payload;
  const value = payload && typeof payload === 'object'
    ? `<button class="btn btn-sm btn-link p-0 align-baseline inspector-link" data-inspect-id="${html(pointerId(payload))}">${html(pointerId(payload))}</button>`
    : html(payload);
  return `<div class="gedcom-row" style="--depth:${depth}"><code>${html(record.tag)}</code><span>${value}</span></div>`
    + record.sub.map((entry) => recordRows(entry, depth + 1)).join('');
}

function linkedButtons(item) {
  const linked = [];
  if (item.kind === 'person') {
    item.families
      .filter((id) => currentGraph.connectors.has(id))
      .forEach((id) => linked.push(
        `<button class="btn btn-sm btn-outline-warning inspector-link" data-inspect-id="${id}">Marriage ${id}</button>`,
      ));
    currentGraph.events.forEach((event) => {
      if (event.personId === item.id) {
        linked.push(
          `<button class="btn btn-sm btn-outline-secondary inspector-event" data-event-id="${event.id}">${html(event.tag)}</button>`,
        );
      }
    });
  } else if (item.kind === 'connector') {
    [...item.parents, ...item.children].forEach((id) => linked.push(
      `<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${id}">${html(currentGraph.people.get(id)?.name || id)}</button>`,
    ));
  } else if (item.kind === 'event') {
    linked.push(
      `<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${item.personId}">${html(currentGraph.people.get(item.personId)?.name || item.personId)}</button>`,
    );
  }
  return linked.length
    ? `<div class="mt-3"><div class="small text-muted mb-2">Linked records</div><div class="d-flex flex-wrap gap-2">${linked.join('')}</div></div>`
    : '';
}

function relativeLevels(personId, maxDegree = 6) {
  const neighbors = new Map();
  const addNeighbor = (firstId, secondId) => {
    if (!firstId || !secondId || firstId === secondId) return;
    const people = neighbors.get(firstId) || new Set();
    people.add(secondId);
    neighbors.set(firstId, people);
  };

  currentGraph.links
    .filter((link) => link.type === 'parenthood')
    .forEach((link) => {
      addNeighbor(link.from, link.to);
      addNeighbor(link.to, link.from);
    });

  currentGraph.connectors.forEach((connector) => {
    const [firstParent, secondParent] = connector.parents;
    addNeighbor(firstParent, secondParent);
    addNeighbor(secondParent, firstParent);
    connector.parents.forEach((parentId) => connector.children.forEach((childId) => {
      addNeighbor(parentId, childId);
      addNeighbor(childId, parentId);
    }));
  });

  const levels = new Map([[personId, 0]]);
  const queue = [personId];
  while (queue.length) {
    const currentId = queue.shift();
    const currentDegree = levels.get(currentId);
    if (currentDegree >= maxDegree) continue;

    neighbors.get(currentId)?.forEach((neighborId) => {
      if (levels.has(neighborId)) return;
      levels.set(neighborId, currentDegree + 1);
      queue.push(neighborId);
    });
  }
  levels.delete(personId);
  return levels;
}

function familyParents(personId) {
  const parents = new Set();
  currentGraph.links
    .filter((link) => link.type === 'parenthood' && link.to === personId)
    .forEach((link) => parents.add(link.from));
  currentGraph.connectors.forEach((connector) => {
    if (connector.children.includes(personId)) {
      connector.parents.forEach((parentId) => parents.add(parentId));
    }
  });
  return parents;
}

function familyChildren(personId) {
  const children = new Set();
  currentGraph.links
    .filter((link) => link.type === 'parenthood' && link.from === personId)
    .forEach((link) => children.add(link.to));
  currentGraph.connectors.forEach((connector) => {
    if (connector.parents.includes(personId)) {
      connector.children.forEach((childId) => children.add(childId));
    }
  });
  return children;
}

function familyPartners(personId) {
  const partners = new Set();
  currentGraph.connectors.forEach((connector) => {
    if (!connector.parents.includes(personId)) return;
    connector.parents
      .filter((partnerId) => partnerId !== personId)
      .forEach((partnerId) => partners.add(partnerId));
  });
  return partners;
}

function sexAwareLabel(person, female, male, neutral) {
  if (person.sex === 'F') return female;
  if (person.sex === 'M') return male;
  return neutral;
}

function relativeRelation(rootId, relativeId, degree) {
  const rootParents = familyParents(rootId);
  const rootChildren = familyChildren(rootId);
  const rootPartners = familyPartners(rootId);
  const relative = currentGraph.people.get(relativeId);

  if (rootPartners.has(relativeId)) {
    return sexAwareLabel(relative, 'wife', 'husband', 'partner');
  }
  if (rootParents.has(relativeId)) {
    return sexAwareLabel(relative, 'mother', 'father', 'parent');
  }
  if (rootChildren.has(relativeId)) {
    return sexAwareLabel(relative, 'daughter', 'son', 'child');
  }

  const rootSiblings = new Set();
  rootParents.forEach((parentId) => {
    familyChildren(parentId).forEach((childId) => {
      if (childId !== rootId) rootSiblings.add(childId);
    });
  });
  if (rootSiblings.has(relativeId)) {
    return sexAwareLabel(relative, 'sister', 'brother', 'sibling');
  }

  const grandparents = new Set();
  rootParents.forEach((parentId) => {
    familyParents(parentId).forEach((grandparentId) => grandparents.add(grandparentId));
  });
  if (grandparents.has(relativeId)) {
    return sexAwareLabel(relative, 'grandmother', 'grandfather', 'grandparent');
  }

  const grandchildren = new Set();
  rootChildren.forEach((childId) => {
    familyChildren(childId).forEach((grandchildId) => grandchildren.add(grandchildId));
  });
  if (grandchildren.has(relativeId)) {
    return sexAwareLabel(relative, 'granddaughter', 'grandson', 'grandchild');
  }

  return '';
}

function relativeLabel(person) {
  const years = [
    String(person.birth || '').match(/\b\d{3,4}\b/)?.[0],
    String(person.death || '').match(/\b\d{3,4}\b/)?.[0],
  ].filter(Boolean).join('–');
  return `${person.name || 'Unknown person'} · ${years || '?'}`;
}

function showRelatives(person) {
  const levels = relativeLevels(person.id);
  const groups = new Map();
  levels.forEach((degree, personId) => {
    const relatives = groups.get(degree) || [];
    const relative = currentGraph.people.get(personId);
    if (relative) {
      relatives.push({
        person: relative,
        relation: relativeRelation(person.id, personId, degree),
      });
    }
    groups.set(degree, relatives);
  });

  const content = [...groups.entries()].sort(([first], [second]) => first - second)
    .map(([degree, relatives]) => `
      <section class="mb-3">
        <h3 class="h6 text-primary">Degree ${degree}</h3>
        <div class="list-group">
          ${relatives
            .sort((first, second) => relativeLabel(first.person).localeCompare(relativeLabel(second.person)))
            .map(({ person: relative, relation }) => `
              <button type="button" class="list-group-item list-group-item-action inspector-relative"
                data-inspect-id="${html(relative.id)}">
                ${html(relativeLabel(relative))}
                ${relation ? `<span class="text-muted">(${html(relation)})</span>` : ''}
              </button>
            `).join('')}
        </div>
      </section>
    `).join('');

  $('#relativesModalBody').html(content || '<p class="text-muted mb-0">No relatives found within six degrees.</p>');
  $('#relativesModalLabel').text(`Relatives of ${person.name || person.id}`);
  relativesModal.show();
}

function showDetails(item) {
  if (!item) return;
  if (item.kind === 'event') {
    const eventTitle = child(item.record, 'DATE')?.payload
      || child(item.record, 'PLAC')?.payload
      || item.record.payload
      || item.tag;
    $detailPanel.html(`
      <div class="small text-primary fw-semibold mb-1">${html(item.tag)} EVENT</div>
      <h3 class="h5 mb-3">${html(eventTitle)}</h3>
      <div class="gedcom-rows">${recordRows(item.record)}</div>
      ${linkedButtons(item)}
    `);
  } else if (item.kind === 'person') {
    const sexLabel = item.sex === 'F' ? 'WOMAN' : item.sex === 'M' ? 'MAN' : 'PERSON';
    $detailPanel.html(`
      <div class="d-flex justify-content-between gap-3">
        <div>
          <div class="small text-primary fw-semibold mb-1">${sexLabel} · ${item.id}</div>
          <h3 class="h5 mb-2 d-flex align-items-center gap-2">
            <span><em>${html(item.givenName)}</em> ${html(item.surname)}</span>
            <button
              type="button"
              class="btn btn-sm btn-outline-primary rounded-circle p-0"
              style="width: 1.5rem; height: 1.5rem;"
              data-show-relatives="${html(item.id)}"
              aria-label="Show relatives"
              title="Show relatives"
            >
              <i class="bi bi-plus-lg" aria-hidden="true"></i>
            </button>
          </h3>
        </div>
        <div class="fs-3">◉</div>
      </div>
      <div class="gedcom-rows mt-3">${recordRows(item.record)}</div>
      ${linkedButtons(item)}
    `);
  } else {
    const title = item.date ? `Married ${html(item.date)}` : 'Marriage';
    $detailPanel.html(`
      <div class="small text-warning-emphasis fw-semibold mb-1">MARRIAGE · ${item.id}</div>
      <h3 class="h5 mb-3">${title}</h3>
      <div class="gedcom-rows">${recordRows(item.record)}</div>
      ${linkedButtons(item)}
    `);
  }
}

function openRootPicker(graph, renderGraph) {
  $mainPersonSelect.empty();
  [...graph.people.values()]
    .sort((first, second) => String(first.birth).localeCompare(String(second.birth)) || first.name.localeCompare(second.name))
    .forEach((person) => {
      const years = [String(person.birth || '').match(/\b\d{3,4}\b/)?.[0], String(person.death || '').match(/\b\d{3,4}\b/)?.[0]]
        .filter(Boolean).join('–');
      $('<option>', { value: person.id, text: `${person.name} · ${years || '?'} · ${person.sex === 'M' || person.sex === 'F' ? person.sex : '?'}` })
        .appendTo($mainPersonSelect);
    });
  $mainPersonSelect.val(graph.rootId || $mainPersonSelect.find('option').first().val());
  $('#mainPersonForm').off('submit').on('submit', (event) => {
    event.preventDefault();
    graph.rootId = $mainPersonSelect.val();
    renderGraph(graph);
    showDetails({ ...graph.people.get(graph.rootId), kind: 'person' });
    mainPersonModal.hide();
  });
  mainPersonModal.show();
}

function loadFile(file, renderGraph) {
  if (!file) return;
  if (!/\.(ged|gedcom|txt)$/i.test(file.name)) {
    $fileMessage.text('Please choose a .ged or .gedcom file.').attr('class', 'small mt-2 text-center text-danger');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const graph = parseGedcom(String(reader.result));
      currentGraph = graph;
      renderBirthplaceMap(graph);
      $fileMessage.text(`${file.name} loaded · ${graph.people.size} people found`)
        .attr('class', `small mt-2 text-center ${graph.errors.length ? 'text-warning' : 'text-success'}`);
      $changeRootButton.prop('disabled', false);
      openRootPicker(graph, renderGraph);
    } catch (error) {
      $fileMessage.text(`Could not parse the GEDCOM file: ${error.message}`).attr('class', 'small mt-2 text-center text-danger');
    }
  };
  reader.onerror = () => $fileMessage.text('The file could not be read.').attr('class', 'small mt-2 text-center text-danger');
  reader.readAsText(file);
}

export function initGraphUI(renderGraph) {
  $('#chooseButton').on('click', (event) => { event.stopPropagation(); $fileInput[0].click(); });
  $fileInput.on('change', () => loadFile($fileInput[0].files[0], renderGraph));
  $uploadZone.on('click', (event) => {
    if (event.target !== $fileInput[0]) $fileInput[0].click();
  });
  ['dragenter', 'dragover'].forEach((eventName) => $uploadZone.on(eventName, (event) => {
    event.preventDefault();
    $uploadZone.addClass('dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => $uploadZone.on(eventName, (event) => {
    event.preventDefault();
    $uploadZone.removeClass('dragging');
  }));
  $uploadZone.on('drop', (event) => loadFile(event.originalEvent.dataTransfer.files[0], renderGraph));
  $changeRootButton.on('click', () => openRootPicker(currentGraph, renderGraph));
  $detailPanel.on('click', '[data-show-relatives]', (event) => {
    const person = currentGraph.people.get($(event.currentTarget).data('showRelatives'));
    if (person) showRelatives(person);
  });
  $('#relativesModalBody').on('click', '.inspector-relative', (event) => {
    const person = currentGraph.people.get($(event.currentTarget).data('inspectId'));
    if (!person) return;
    relativesModal.hide();
    showDetails({ ...person, kind: 'person' });
  });
  $detailPanel.on('click', '[data-inspect-id], [data-event-id]', (event) => {
    const $target = $(event.currentTarget);
    const item = $target.data('eventId')
      ? currentGraph.events.get($target.data('eventId'))
      : currentGraph.people.get($target.data('inspectId')) || currentGraph.connectors.get($target.data('inspectId'));
    showDetails(item ? {
      ...item,
      kind: $target.data('eventId') ? 'event' : item.kind || (currentGraph.people.has(item.id) ? 'person' : 'connector'),
    } : null);
  });
  return showDetails;
}
