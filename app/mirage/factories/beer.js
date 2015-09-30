import Mirage, {faker} from 'ember-cli-mirage';

export default Mirage.Factory.extend({
  name() {
    const variety = faker.list.random('ale', 'lager')();
    return `${faker.commerce.color()} ${variety}`;
  }
});
