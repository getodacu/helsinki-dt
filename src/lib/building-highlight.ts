import * as THREE from 'three';

/** Tint the visible surface in its existing draw, without a competing depth layer. */
export class BuildingHighlight {
  readonly ids = new Map<string, number>();
  private features: readonly string[];
  private selected = { value: -1 };
  private hovered = { value: -1 };
  constructor(features: readonly string[]) {
    this.features = features;
    for (const id of features) if (!this.ids.has(id)) this.ids.set(id, this.ids.size);
  }
  set(selected: string | null, hovered: string | null) {
    this.selected.value = selected === null ? -1 : this.ids.get(selected) ?? -1;
    this.hovered.value = hovered === null ? -1 : this.ids.get(hovered) ?? -1;
  }
  apply(root: THREE.Object3D) {
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.geometry.getAttribute('_feature_id_0');
      if (!source || source.itemSize !== 1 || source.count !== object.geometry.getAttribute('position')?.count) throw new Error('Missing building feature indices');
      const values = new Float32Array(source.count);
      for (let vertex = 0; vertex < source.count; vertex++) {
        const feature = source.getX(vertex);
        if (!Number.isInteger(feature) || feature < 0 || feature >= this.features.length) throw new Error('Invalid building feature index');
        values[vertex] = this.ids.get(this.features[feature])!;
      }
      object.geometry.setAttribute('buildingFeature', new THREE.BufferAttribute(values, 1));
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
          shader.uniforms.selectedBuilding = this.selected;
          shader.uniforms.hoveredBuilding = this.hovered;
          shader.uniforms.selectedBuildingColour = { value: new THREE.Color('#82e3be') };
          shader.uniforms.hoveredBuildingColour = { value: new THREE.Color('#efd4a2') };
          shader.vertexShader = 'attribute float buildingFeature; varying float vBuildingFeature;\n' + shader.vertexShader
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBuildingFeature = buildingFeature;');
          shader.fragmentShader = 'varying float vBuildingFeature; uniform float selectedBuilding; uniform float hoveredBuilding; uniform vec3 selectedBuildingColour; uniform vec3 hoveredBuildingColour;\n' + shader.fragmentShader
            .replace('#include <opaque_fragment>', `
              if (selectedBuilding >= 0.0 && abs(vBuildingFeature - selectedBuilding) < 0.5) {
                outgoingLight = mix(outgoingLight, selectedBuildingColour, 0.72);
              } else if (hoveredBuilding >= 0.0 && abs(vBuildingFeature - hoveredBuilding) < 0.5) {
                outgoingLight = mix(outgoingLight, hoveredBuildingColour, 0.72);
              }
              #include <opaque_fragment>`);
        };
        material.customProgramCacheKey = () => 'building-highlight-v1';
        material.needsUpdate = true;
      }
    });
  }
}
