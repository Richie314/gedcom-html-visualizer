import $ from 'jquery';
import { GEDCStruct, g5ConfGEDC } from 'js-gedcom';

const $uploadZone = $('#uploadZone');
const $fileInput = $('#fileInput');
const $fileMessage = $('#fileMessage');
const $detailPanel = $('#detailPanel');
const $changeRootButton = $('#changeRootButton');
const $mainPersonSelect = $('#mainPersonSelect');
const mainPersonModal = new bootstrap.Modal('#mainPersonModal');
let currentGraph = { people: new Map(), connectors: new Map(), events: new Map(), links: [] };

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
    item.families.filter((id) => currentGraph.connectors.has(id)).forEach((id) => linked.push(`<button class="btn btn-sm btn-outline-warning inspector-link" data-inspect-id="${id}">Marriage ${id}</button>`));
    currentGraph.events.forEach((event) => {
      if (event.personId === item.id) linked.push(`<button class="btn btn-sm btn-outline-secondary inspector-event" data-event-id="${event.id}">${html(event.tag)}</button>`);
    });
  } else if (item.kind === 'connector') {
    [...item.parents, ...item.children].forEach((id) => linked.push(`<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${id}">${html(currentGraph.people.get(id)?.name || id)}</button>`));
  } else if (item.kind === 'event') {
    linked.push(`<button class="btn btn-sm btn-outline-primary inspector-link" data-inspect-id="${item.personId}">${html(currentGraph.people.get(item.personId)?.name || item.personId)}</button>`);
  }
  return linked.length ? `<div class="mt-3"><div class="small text-muted mb-2">Linked records</div><div class="d-flex flex-wrap gap-2">${linked.join('')}</div></div>` : '';
}

function showDetails(item) {
  if (!item) return;
  if (item.kind === 'event') {
    const eventTitle = child(item.record, 'DATE')?.payload || child(item.record, 'PLAC')?.payload || item.record.payload || item.tag;
    $detailPanel.html(`<div class="small text-primary fw-semibold mb-1">${html(item.tag)} EVENT</div><h3 class="h5 mb-3">${html(eventTitle)}</h3><div class="gedcom-rows">${recordRows(item.record)}</div>${linkedButtons(item)}`);
  } else if (item.kind === 'person') {
    const sexLabel = item.sex === 'F' ? 'WOMAN' : item.sex === 'M' ? 'MAN' : 'PERSON';
    $detailPanel.html(`<div class="d-flex justify-content-between gap-3"><div><div class="small text-primary fw-semibold mb-1">${sexLabel} · ${item.id}</div><h3 class="h5 mb-2">${html(item.givenName)} <em>${html(item.surname)}</em></h3></div><div class="fs-3">◉</div></div><div class="gedcom-rows mt-3">${recordRows(item.record)}</div>${linkedButtons(item)}`);
  } else {
    $detailPanel.html(`<div class="small text-warning-emphasis fw-semibold mb-1">MARRIAGE · ${item.id}</div><h3 class="h5 mb-3">${item.date ? `Married ${html(item.date)}` : 'Marriage'}</h3><div class="gedcom-rows">${recordRows(item.record)}</div>${linkedButtons(item)}`);
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
