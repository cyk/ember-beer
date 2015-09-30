/**
 Ember Data: Dependent Relationships (Ember Data v1.13.x)

 This package extends Ember Data to support creating relationships
 where a model's dirty state depends not only on its own attributes
 but on the dirty state of models in dependent relationships as well.

 ```javascript
 App.Thing = DS.Model.extend({
    name     : DS.attr('string'),
    children : DS.hasMany('thing', { dependent: true })
  });

 // Load all the things

 var thing = store.findById('thing', '1');
 var child = thing.get('children.firstObject');

 thing.get('hasDirtyAttributes'); // false
 child.get('name'); // 'foo'

 child.set('name', 'bar');
 thing.get('hasDirtyAttributes'); // true

 thing.rollback();
 child.get('name'); // 'foo'
 ```

 Note that saving dependent relations automatically, and handling
 'isValid' state based on dependent relations is not supported.
 */
/* global Ember, DS */
(function() {
  var get = Ember.get;
  var set = Ember.set;

  // Returns the internal model for the given record
  function internalModelFor(record) {
    var internalModel = record._internalModel;

    // Ensure the internal model has a dependent relationship hash, since we can't override the
    // constructor function anymore
    if (!internalModel._dependentRelationships) {
      internalModel._dependentRelationships = {};
    }

    return internalModel;
  }

  // Replace a method on an object with a new one that calls the original and then
  // invokes a function with the result
  function decorateMethod(obj, name, fn) {
    var originalFn = obj[name];

    obj[name] = function() {
      var value = originalFn.apply(this, arguments);

      return fn.call(this, value, arguments);
    };
  }

  //
  // State machine handlers
  //

  // Object/array agnostic 'hasDirtyAttributes' check
  function isRelatedRecordDirty(value) {
    return Ember.isArray(value) ? Ember.A(value).isAny('hasDirtyAttributes') : get(value, 'hasDirtyAttributes');
  }

  // Original-state aware dirty check
  function isRelationshipDirty(internalModel, key) {
    var value = get(internalModel.record, key).toArray();
    var originalValue = internalModel._dependentRelationships[key];

    return Ember.compare(value, originalValue) !== 0;
  }

  // The new de facto check to determine if a record is dirty
  function isRecordDirty(internalModel) {
    // First check normal attributes
    if (Object.keys(internalModel._attributes).length) {
      return true;
    }

    if (internalModel._dependentRelationships) {
      // Then check dependent relations
      return Ember.A(Object.keys(internalModel._dependentRelationships)).any(function(key) {
        return isRelationshipDirty(internalModel, key) || isRelatedRecordDirty(get(internalModel.record, key));
      });
    }
  }

  // A dependent relationship can change if:
  //   * a belongsTo gets changed to another record
  //   * a belongsTo record dirties/cleans
  //   * a hasMany array gets added to or removed from
  //   * a hasMany array has a record that dirties/cleans
  var dependentRelationshipDidChange = function(internalModel, context) {
    var compareRelation = function(value, originalValue) {
      if (Ember.compare(value, originalValue) !== 0 || isRelatedRecordDirty(context.value)) {
        internalModel.send('becomeDirty');
      } else {
        internalModel.send('propertyWasReset');
      }
    };

    if(Ember.isArray(context.value) && Ember.isArray(context.originalValue)) {
      compareRelation(context.value.sortBy('id'), context.originalValue.sortBy('id'));
    } else {
      compareRelation(context.value, context.originalValue);
    }
  };

  // The check for whether the record is still dirty now has to account for dependent relations
  var propertyWasReset = function(internalModel) {
    if (!isRecordDirty(internalModel)) {
      internalModel.send('rolledBack');
    }
  };

  // Check to see if the saved record is dirty
  var savedSetup = function(internalModel) {
    if (isRecordDirty(internalModel)) {
      internalModel.adapterDidDirty();
    }
  };

  //
  // Perform some state machine surgery
  // TODO: figure out how to make this less ass
  //

  // Handle dependent relationship change
  DS.RootState.loaded.dependentRelationshipDidChange = dependentRelationshipDidChange;

  // Changes to dependent relations while in-flight, invalid, or deleted should not alter its state
  DS.RootState.loaded.created.inFlight.dependentRelationshipDidChange = Ember.K;
  DS.RootState.loaded.updated.inFlight.dependentRelationshipDidChange = Ember.K;
  DS.RootState.loaded.created.invalid.dependentRelationshipDidChange = Ember.K;
  DS.RootState.loaded.updated.invalid.dependentRelationshipDidChange = Ember.K;
  DS.RootState.deleted.dependentRelationshipDidChange = Ember.K;

  // Override the property reset handler to account for dependent relations
  DS.RootState.loaded.created.uncommitted.propertyWasReset = propertyWasReset;
  DS.RootState.loaded.updated.uncommitted.propertyWasReset = propertyWasReset;

  // Handle the case when a record that is in the 'root.deleted.uncommitted' state
  // is rolled back but has dirty dependent relations
  DS.RootState.loaded.saved.setup = savedSetup;

  //
  // Modify DS.Model
  //

  // Add dependent property helpers
  DS.Model.reopenClass({
    // Loop over each dependent relation, passing the property name and the relationship meta
    eachDependentRelationship: function(callback, binding) {
      get(this, 'relationshipsByName').forEach(function(relationship, name) {
        if (relationship.options.dependent) {
          callback.call(binding, name, relationship);
        }
      });
    }
  });

  DS.Model.reopen(Ember.Comparable, {
    // Loop over each dependent property
    eachDependentRelationship: function(callback, binding) {
      this.constructor.eachDependentRelationship(callback, binding || this);
    },

    // Hook into the object creation lifecycle in order to add dirty observers
    didDefineProperty: function(proto, key, value) {
      this._super(proto, key, value);

      if (value && typeof value === 'object' && value.isDescriptor) {
        var meta = value.meta();

        if (meta.isRelationship && meta.options.dependent) {
          if (meta.kind === 'belongsTo') {
            Ember.addObserver(proto, key + '.hasDirtyAttributes', null, 'dependentRelationshipDidChange');
          } else if (meta.kind === 'hasMany') {
            Ember.addObserver(proto, key + '.@each.hasDirtyAttributes', null, 'dependentRelationshipDidChange');
          }
        }
      }
    },

    // Returns object describing of changed relationships, like `changedAttributes`
    changedRelationships: function() {
      var record = this;
      var internalModel = internalModelFor(record);
      var dependentRelations = internalModel._dependentRelationships;
      var relationship;
      var changed = {};

      record.eachDependentRelationship(function(name, relationshipMeta) {
        relationship = get(record, name);
        if (relationship && isRelationshipDirty(internalModel, name)) {
          changed[name] = [
            Ember.copy(dependentRelations[name]),
            relationshipMeta.kind === 'belongsTo' ? relationship : relationship.toArray()
          ];
        }
      });

      return changed;
    },

    // Observer for relationship change, should send state machine message 'dependentRelationshipDidChange'
    dependentRelationshipDidChange: Ember.observer(function(record, key) {
      var dependentRelations = internalModelFor(record)._dependentRelationships;
      var name = key.split('.')[0];

      if (name in dependentRelations) {
        var value = get(record, name);

        // Make DS.ManyArray into a vanilla array for comparison with original
        if (Ember.isArray(value)) {
          value = value.toArray();
        }

        record.send('dependentRelationshipDidChange', {
          name          : name,
          value         : value,
          originalValue : dependentRelations[name]
        });
      }
    }),

    // When the record is loaded/saved, save its relations so they can be reverted
    snapshotDependentRelations: function() {
      var record = this;
      var dependentRelations = internalModelFor(record)._dependentRelationships;
      var relationship;

      record.eachDependentRelationship(function(name, relationshipMeta) {
        if (relationship = get(record, name)) {
          Ember.RSVP.all([relationship]).then(function(results) {
            relationship = results[0];
            dependentRelations[name] = relationshipMeta.kind === 'belongsTo' ? relationship : relationship.toArray();
          });
        }
      });

      // Pre-compute as dependent relations rely on the 'hasDirtyAttributes' CP, which may not get called
      get(record, 'hasDirtyAttributes');
    }.on('didLoad'),

    // Basic identity comparison to allow `Ember.compare` to work on models
    compare: function(r1, r2) {
      return r1 === r2 ? 0 : 1;
    }
  });

  //
  // Modify DS.InternalModel.prototype
  //

  var InternalModelPrototype = DS.InternalModel.prototype;

  /**
   Update the dependent relations when the adapter loads new data
   @method adapterDidCommit
   */
  decorateMethod(InternalModelPrototype, 'adapterDidCommit', function adapterDidCommit() {
    var record = this.record;

    record.snapshotDependentRelations();

    // Relationship updates don't trigger data changes anymore, so manually
    // notify all relationship properties of possible change
    record.eachDependentRelationship(function(name, relationship) {
      if (relationship.kind === 'hasMany') {
        record.dependentRelationshipDidChange(this, name);
      }
    });
  });

  /**
   Rollback relations as well as attributes
   @method rollbackAttributes
   */
  decorateMethod(InternalModelPrototype, 'rollbackAttributes', function rollbackDependentRelationships() {
    var internalModel = this;
    var dependentRelations = internalModel._dependentRelationships;
    var record = internalModel.record;

    record.eachDependentRelationship(function(name, relationshipMeta) {
      if (name in dependentRelations) {
        var originalRelationship = dependentRelations[name];

        if (relationshipMeta.kind === 'belongsTo') {
          set(record, name, originalRelationship);
        } else {
          get(record, name).setObjects(originalRelationship);
        }

        // Rollback child/field records that have changed as well
        Ember.makeArray(originalRelationship).filterBy('hasDirtyAttributes').invoke('rollbackAttributes');
      }
    });
  });
}());