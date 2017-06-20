import {Stream} from 'xstream';
import {adapt} from '@cycle/run/lib/adapt';
import isolate from '@cycle/isolate';
import {pickMerge} from './pickMerge';
import {pickCombine} from './pickCombine';
import {InternalInstances, Lens} from './types';

const identityLens = {
  get: <T>(outer: T) => outer,
  set: <T>(outer: T, inner: T) => inner,
};

function instanceLens(getKey: any, key: string): Lens<Array<any>, any> {
  return {
    get(arr: Array<any> | undefined): any {
      if (typeof arr === 'undefined') {
        return void 0;
      } else {
        for (let i = 0, n = arr.length; i < n; ++i) {
          if (getKey(arr[i]) === key) {
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
        return arr.filter(s => getKey(s) !== key);
      } else {
        return arr.map(s => {
          if (getKey(s) === key) {
            return item;
          } else {
            return s;
          }
        });
      }
    },
  };
}

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

export type MakeScopesFn = (key: string | number) => string | object;

function defaultMakeScopes(key: string) {
  return {'*': null};
}

export class Collection<S, Si> {
  protected _itemComp: (sources: any) => Si;
  protected _state$: Stream<Array<S>>;
  protected _name: string;
  protected _getKey: ((state: S) => string) | null;
  protected _makeScopes: MakeScopesFn;

  constructor(itemComp: (sources: any) => Si,
              state$: Stream<Array<S>>,
              name: string,
              makeScopes: MakeScopesFn = defaultMakeScopes) {
    this._itemComp = itemComp;
    this._state$ = state$;
    this._name = name;
    this._makeScopes = makeScopes;
    this._getKey = null;
  }

  public uniqueBy(getKey: (state: S) => string): UniqueCollection<S, Si> {
    return new UniqueCollection<S, Si>(this._itemComp, this._state$, this._name, getKey, this._makeScopes);
  }

  public isolateEach(makeScopes: MakeScopesFn): Collection<S, Si> {
    return new Collection<S, Si>(this._itemComp, this._state$, this._name, makeScopes);
  }

  public build(sources: any): Instances<Si> {
    const instances$ = this._state$.fold((acc: InternalInstances<Si>, nextState: Array<any> | any) => {
      const dict = acc.dict;
      if (Array.isArray(nextState)) {
        const nextInstArray = Array(nextState.length) as Array<Si & {_key: string}>;
        const nextKeys = new Set<string>();
        // add
        for (let i = 0, n = nextState.length; i < n; ++i) {
          const key = this._getKey === null ? `${i}` : this._getKey(nextState[i]);
          nextKeys.add(key);
          if (this._getKey === null || !dict.has(key)) {
            const onionScope = this._getKey === null ?
              i :
              instanceLens(this._getKey, key);
            const otherScopes = this._makeScopes(key);
            const scopes = typeof otherScopes === 'string' ?
              {'*': otherScopes, [this._name]: onionScope}  :
              {...otherScopes, [this._name]: onionScope};
            const sinks = isolate(this._itemComp, scopes)(sources);
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
        const key = this._getKey === null ? 'this' : this._getKey(nextState);
        const onionScope = identityLens;
        const otherScopes = this._makeScopes(key);
        const scopes = typeof otherScopes === 'string' ?
          {'*': otherScopes, [this._name]: onionScope}  :
          {...otherScopes, [this._name]: onionScope};
        const sinks = isolate(this._itemComp, scopes)(sources);
        dict.set(key, sinks);
        return {dict: dict, arr: [sinks]}
      }
    }, {dict: new Map(), arr: []} as InternalInstances<Si>);

    return new Instances<Si>(instances$);
  }
}

export class UniqueCollection<S, Si> extends Collection<S, Si> {
  protected _getKey: ((state: S) => string);

  constructor(itemComp: (sources: any) => Si,
              state$: Stream<Array<S>>,
              name: string,
              getKey: (state: S) => string,
              makeScopes: MakeScopesFn = defaultMakeScopes) {
    super(itemComp, state$, name, makeScopes);
    this._getKey = getKey;
  }

  public isolateEach(makeScopes: (key: string) => string | object): UniqueCollection<S, Si> {
    return new UniqueCollection<S, Si>(this._itemComp, this._state$, this._name, this._getKey, makeScopes);
  }
}