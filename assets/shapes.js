import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';


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

export function createPersonNode(position, color, label, data, connector = false) {
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

  const labelSpriteNode = labelSprite(label, '#fff', data.type, connector);
  labelSpriteNode.position.copy(position).add(new THREE.Vector3(0, connector ? .68 : 1, 0));

  return {
    personNode: mesh,
    labelSpriteNode,
  }
}

export function createLink(from, to, color, radius) {
  const distance = from.distanceTo(to);
  const midpoint = from.clone().add(to).multiplyScalar(.5);

  const geometry = new THREE.CylinderGeometry(radius, radius, distance, 10);
  const material = new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: true });

  const line = new THREE.Mesh(geometry, material);
  line.position.copy(midpoint);
  line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  line.renderOrder = 1;
  return line;
}

/**
 * Returns an heart shape
 * @param pos position of the center of the heart 
 * @returns The mesh ready to be added to the scene
 */
export function createHeart() {
  const scale = .1;
  const color = 0xd83b45;
  const depth = .7;
 
  const x = 0, y = 0;
  const heartShape = new THREE.Shape();
  heartShape.moveTo(x, y);
  heartShape.bezierCurveTo(x, y - 3, x - 6, y - 3, x - 6, y + 2.5);
  heartShape.bezierCurveTo(x - 6, y + 5.5, x - 3, y + 7.5, x, y + 9.5);
  heartShape.bezierCurveTo(x + 3, y + 7.5, x + 6, y + 5.5, x + 6, y + 2.5);
  heartShape.bezierCurveTo(x + 6, y - 3, x, y - 3, x, y);
 
  const geometry = new THREE.ExtrudeGeometry(heartShape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 1,
    bevelSize: 1,
    bevelSegments: 4,
    curveSegments: 32
  });
  geometry.center();
 
  const material = new THREE.MeshPhongMaterial({ 
    color, 
    shininess: 60, 
    opacity: 1, 
    transparent: false,
  });

  const heart = new THREE.Mesh(geometry, material);
  heart.scale.setScalar(scale);
  return heart;
}

export function placeOnLineMiddle(obj, pointA, pointB) {
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  const dz = pointB.z - pointA.z;

  const angleY = Math.PI - Math.atan2(dz, dx);
  const angleZ = Math.PI + Math.atan2(dy, dx);

  obj.position.set(
    (pointA.x + pointB.x) / 2,
    (pointA.y + pointB.y) / 2,
    (pointA.z + pointB.z) / 2,
  );
  obj.rotation.y = angleY;
  obj.rotation.z = angleZ;
}