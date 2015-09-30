import Ember from 'ember';

export default Ember.Route.extend({
  model() {
    return Ember.RSVP.hash({
      breweries: this.store.findAll('brewery'),
      beers: this.store.findAll('beer')
    });
  },

  setupController(controller, model) {
    controller.setProperties(model);
  },

  actions: {
    saveBrewery(brewery) {
      brewery.save();
    },
    saveBeer(beer) {
      beer.save();
    }
  }
});
