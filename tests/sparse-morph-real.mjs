import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
register(pathToFileURL(path.join(root, 'tests/morph-filter-three-hook.mjs')));
const { GeometryBuilder } = await import(pathToFileURL(path.join(root, 'app/lib/examples/jsm/loaders/MMDLoader.js')));
const { MMDParser } = await import(pathToFileURL(path.join(root, 'app/lib/examples/jsm/libs/mmdparser.module.js')));
const { Mesh, AnimationMixer, AnimationClip, NumberKeyframeTrack } = await import(pathToFileURL(path.join(root, 'app/lib/three.module.js')));
const { createSparseMorphController } = await import(pathToFileURL(path.resolve(process.argv[2] || path.join(root, 'app/lib/SparseMorphController.js'))));
const names = new Set(['まばたき','left','right','up','down','あ','い','う','え','お','口','にこり','笑い','照れ','びっくり','笑い目']);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
export const results = [];
for (const file of walk(path.join(root, 'model')).filter((p) => p.endsWith('.pmx'))) {
  const b = fs.readFileSync(file);
  const data = new MMDParser.Parser().parsePmx(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength), true);
  const geometry = new GeometryBuilder().build(data, names);
  const mesh = new Mesh(geometry, []);
  const dense = geometry.morphAttributes.position.map((a) => a.array);
  const base = geometry.attributes.position.array.slice();
  const skinIndex = geometry.attributes.skinIndex.array.slice();
  const skinWeight = geometry.attributes.skinWeight.array.slice();
  const index = geometry.index.array.slice();
  const influences = mesh.morphTargetInfluences;
  const dictionary = mesh.morphTargetDictionary;
  const controller = createSparseMorphController(mesh);
  assert.ok(controller, 'real model must enter sparse mode');
  assert.equal(geometry.morphAttributes.position, undefined);
  assert.equal(mesh.morphTargetInfluences, influences);
  assert.equal(mesh.morphTargetDictionary, dictionary);
  const mixer = new AnimationMixer(mesh);
  const clip = new AnimationClip('sparse-binding-check', 1, [
    new NumberKeyframeTrack('.morphTargetInfluences[まばたき]', [0, 1], [0, 1]),
  ]);
  mixer.clipAction(clip).play();
  mixer.update(0.5);
  assert.ok(Math.abs(influences[dictionary['まばたき']] - 0.5) < 1e-6, 'AnimationMixer still binds named morph weights');
  controller.update();
  mixer.stopAllAction();
  const cases = Array.from({length:dense.length},(_,i)=>Array.from({length:dense.length},(_,j)=>i===j?1:0));
  cases.push(dense.map((_,i)=>i%3===0?-0.4:i%3===1?1.2:0.7));
  cases.push(dense.map((_,i)=>i%2?0.25:0.6));
  cases.push(dense.map(()=>0));
  let worst = 0;
  for (const weights of cases) {
    weights.forEach((w,i)=>{influences[i]=w;});
    controller.update();
    const baseInfluence = 1 - weights.reduce((n,w)=>n+w,0);
    const actual = geometry.attributes.position.array;
    const ranges = geometry.attributes.position.updateRanges;
    assert.ok(ranges.length > 0 && ranges.length <= 4, 'real face uploads are batched');
    for (const range of ranges) assert.ok(range.start >= 0 && range.count > 0 && range.start + range.count <= base.length);
    for (let i=0;i<base.length;i++) {
      let expected = base[i] * baseInfluence;
      for (let j=0;j<dense.length;j++) if(weights[j]) expected += dense[j][i] * weights[j];
      const error = Math.abs(actual[i]-expected);
      if(error>worst) worst=error;
      assert.ok(error <= 2e-5, `${path.basename(file)} position ${i}: ${actual[i]} != ${expected}`);
      if (actual[i] !== base[i]) assert.ok(ranges.some((r)=>i>=r.start&&i<r.start+r.count), 'GPU ranges include every changed component');
    }
  }
  assert.deepEqual(geometry.attributes.skinIndex.array,skinIndex);
  assert.deepEqual(geometry.attributes.skinWeight.array,skinWeight);
  assert.deepEqual(geometry.index.array,index);
  assert.deepEqual(geometry.attributes.position.array,base,'zero weights restore bind positions');
  results.push({model:path.basename(file),cases:cases.length,animationMixerBinding:true,maxAbsoluteError:worst,vertices:base.length/3,stats:controller.stats});
}
for(const result of results)console.log(JSON.stringify(result));
