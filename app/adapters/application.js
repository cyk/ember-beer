import DS from 'ember-data';

export default DS.RESTAdapter.extend({
  shouldReloadAll() {
    return true;
  }
})