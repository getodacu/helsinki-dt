import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BuildingHighlight } from '../src/lib/building-highlight.ts';
import { makeChunkGeometry, disposeTree } from '../src/lib/scene.ts';
import type { BuildingChunk } from '../src/lib/types.ts';

test('selection tints the existing draw, merges repeated feature rows and takes precedence over hover', () => {
  const chunk = { positions: [0,0,0,1,0,0,0,0,1, 2,0,0,3,0,0,2,0,1, 4,0,0,5,0,0,4,0,1],
    ranges: ['A','B','A'].map((buildingId, firstTriangle) => ({ buildingId, firstTriangle, triangleCount: 1 })) } as BuildingChunk;
  const mesh = new THREE.Mesh(makeChunkGeometry(chunk), new THREE.MeshBasicMaterial());
  const positions = mesh.geometry.getAttribute('position'), highlight = new BuildingHighlight(['A','B','A']);
  highlight.apply(mesh); highlight.set('A','A');
  assert.equal(mesh.geometry.getAttribute('position'), positions); assert.equal(mesh.children.length, 0);
  assert.deepEqual([...mesh.geometry.getAttribute('buildingFeature').array], [0,0,0,1,1,1,0,0,0]);
  assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.depthTest, true); assert.equal(mesh.material.depthWrite, true);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  mesh.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.equal(shader.uniforms.selectedBuilding.value, 0); assert.equal(shader.uniforms.hoveredBuilding.value, 0);
  highlight.set(null,'B'); assert.equal(shader.uniforms.selectedBuilding.value, -1); assert.equal(shader.uniforms.hoveredBuilding.value, 1);
  highlight.set('missing',null); assert.equal(shader.uniforms.selectedBuilding.value, -1); assert.equal(shader.uniforms.hoveredBuilding.value, -1);
  disposeTree(mesh);
});

test('invalid or missing source feature indices fail before hiding the prepared model', () => {
  const highlight = new BuildingHighlight(['A']), geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,0,1],3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  assert.throws(() => highlight.apply(mesh), /Missing building feature/);
  for (const invalid of [-1,0.5,1,NaN]) {
    geometry.setAttribute('_feature_id_0', new THREE.Float32BufferAttribute([0,invalid,0],1));
    assert.throws(() => highlight.apply(mesh), /Invalid building feature/);
  }
  disposeTree(mesh);
});
