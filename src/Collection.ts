import xs, {Stream} from 'xstream';
import {adapt} from '@cycle/run/lib/adapt';
import isolate from '@cycle/isolate';
import {pickMerge} from './pickMerge';
import {pickCombine} from './pickCombine';
import {StateSource} from './StateSource';
import {InternalInstances, Lens, ItemKeyFn, ItemScopeFn} from './types';

/**
 * An object representing all instances in a collection of components. Has the
 * methods pickCombine and pickMerge to get the combined sinks of all instances.
 */
export class Instances<Si> {
  private _instances$: Stream<InternalInstances<Si>>;

  constructor(instances$: Stream<InternalInstances<Si>>) {
    this._instances$ = instances$;
  }

  /**
   * Like `merge` in xstream, this operator blends multiple streams together, but
   * picks those streams from a collection of component instances.
   *
   * Use the `selector` string to pick a stream from the sinks object of each
   * component instance, then pickMerge will merge all those picked streams.
   *
   * @param {String} selector a name of a channel in a sinks object belonging to
   * each component in the collection of components.
   * @return {Function} an operator to be used with xstream's `compose` method.
   */
  public pickMerge(selector: string): Stream<any> {
    return adapt(this._instances$.compose(pickMerge(selector)));
  }

  /**
   * Like `combine` in xstream, this operator combines multiple streams together,
   * but picks those streams from a collection of component instances.
   *
   * Use the `selector` string to pick a stream from the sinks object of each
   * component instance, then pickCombine will combine all those picked streams.
   *
   * @param {String} selector a name of a channel in a sinks object belonging to
   * each component in the collection of components.
   * @return {Function} an operator to be used with xstream's `compose` method.
   */
  public pickCombine(selector: string): Stream<Array<any>> {
    return adapt(this._instances$.compose(pickCombine(selector)));
  }
}

export interface CollectionOptions<S, So, Si> {
  /**
   * The Cycle.js component for each item in this collection. Should be just a
   * function from sources to sinks.
   */
  item: (so: So) => Si;

  /**
   * A function that describes how to collect all the sinks from all item
   * instances. The instances argument is an object with two methods: pickMerge
   * and pickCombine. These behave like xstream "merge" and "combine" operators,
   * but are applied to the dynamic collection of all item instances.
   *
   * This function should return an object of sinks. This is what the collection
   * component will output as its sinks.
   */
  collectSinks: (instances: Instances<Si>) => any;

  /**
   * Specify, from the state object for each item in the collection, a key for
   * that item. This avoids bugs when the collection grows or shrinks, as well
   * as helps determine the isolation scope for each item, when specifying the
   * `itemScope` option. This function also takes the index number (from the
   * corresponding entry in the state array) as the second argument.
   *
   * Example:
   *
   * ```js
   * itemKey: (itemState, index) => itemState.key
   * ```
   */
  itemKey?: ItemKeyFn<S>;

  /**
   * Specify each item's isolation scope, given the item's key.
   *
   * Pass a function which describes how to create the isolation scopes for each
   * item component, given that item component's unique key. The unique key for
   * each item was defined by the `itemKey` option.
   */
  itemScope?: ItemScopeFn;

  /**
   * Choose the channel name where the StateSource exists. Typically this is
   * 'onion', but you can customize it if your app is using another name. It is
   * used for referencing the correct source used for describing
   * growing/shrinking of the collection of items.
   */
  channel?: string;
}

function defaultItemScope(key: string) {
  return {'*': null};
}

function instanceLens(itemKey: ItemKeyFn<any>, key: string): Lens<Array<any>, any> {
  return {
    get(arr: Array<any> | undefined): any {
      if (typeof arr === 'undefined') {
        return void 0;
      } else {
        for (let i = 0, n = arr.length; i < n; ++i) {
          if (`${itemKey(arr[i], i)}` === key) {
            return arr[i];
          }
        }
        return void 0;
      }
    },

    set(arr: Array<any> | undefined, item: any): any {
      if (typeof arr === 'undefined') {
        return [item];
      } else if (typeof item === 'undefined') {
        return arr.filter((s, i) => `${itemKey(s, i)}` !== key);
      } else {
        return arr.map((s, i) => {
          if (`${itemKey(s, i)}` === key) {
            return item;
          } else {
            return s;
          }
        });
      }
    },
  };
}

const identityLens = {
  get: <T>(outer: T) => outer,
  set: <T>(outer: T, inner: T) => inner,
};

/**
 * Returns a Cycle.js component (a function from sources to sinks) that
 * represents a collection of many item components of the same type.
 *
 * Takes an "options" object as input, with the required properties:
 * - item
 * - collectSinks
 *
 * And the optional properties:
 * - itemKey
 * - itemScope
 * - channel
 *
 * The returned component, the Collection, will use the state source passed to
 * it (through sources) to guide the dynamic growing/shrinking of instances of
 * the item component.
 *
 * Typically the state source should emit arrays, where each entry in the array
 * is an object holding the state for each item component. When the state array
 * grows, the collection will automatically instantiate a new item component.
 * Similarly, when the state array gets smaller, the collection will handle
 * removal of the corresponding item instance.
 */
export function makeCollection<S, So, Si>(opts: CollectionOptions<S, So, Si>) {
  return function collectionComponent(sources: any) {
    const name = opts.channel || 'onion';
    const itemKey = opts.itemKey;
    const itemScope = opts.itemScope || defaultItemScope;
    const itemComp = opts.item;
    const state$ = xs.fromObservable((sources[name] as StateSource<S>).state$);
    const instances$ = state$.fold((acc: InternalInstances<Si>, nextState: Array<any> | any) => {
      const dict = acc.dict;
      if (Array.isArray(nextState)) {
        const nextInstArray = Array(nextState.length) as Array<Si & {_key: string}>;
        const nextKeys = new Set<string>();
        // add
        for (let i = 0, n = nextState.length; i < n; ++i) {
          const key = `${itemKey ? itemKey(nextState[i], i) : i}`;
          nextKeys.add(key);
          if (!dict.has(key)) {
            const onionScope = itemKey ? instanceLens(itemKey, key) : `${i}`;
            const otherScopes = itemScope(key);
            const scopes = typeof otherScopes === 'string' ?
              {'*': otherScopes, [name]: onionScope}  :
              {...otherScopes, [name]: onionScope};
            const sinks = isolate(itemComp, scopes)(sources);
            dict.set(key, sinks);
            nextInstArray[i] = sinks;
          } else {
            nextInstArray[i] = dict.get(key) as any;
          }
          nextInstArray[i]._key = key;
        }
        // remove
        dict.forEach((_, key) => {
          if (!nextKeys.has(key)) {
            dict.delete(key);
          }
        });
        nextKeys.clear();
        return {dict: dict, arr: nextInstArray};
      } else {
        dict.clear();
        const key = `${itemKey ? itemKey(nextState, 0) : 'this'}`;
        const onionScope = identityLens;
        const otherScopes = itemScope(key);
        const scopes = typeof otherScopes === 'string' ?
          {'*': otherScopes, [name]: onionScope}  :
          {...otherScopes, [name]: onionScope};
        const sinks = isolate(itemComp, scopes)(sources);
        dict.set(key, sinks);
        return {dict: dict, arr: [sinks]}
      }
    }, {dict: new Map(), arr: []} as InternalInstances<Si>);
    return opts.collectSinks(new Instances<Si>(instances$));
  }
}
