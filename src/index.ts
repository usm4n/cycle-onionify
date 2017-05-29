import {DevToolEnabledSource} from '@cycle/run';
import xs, {Stream, MemoryStream, InternalListener, OutSender, Operator} from 'xstream';
import dropRepeats from 'xstream/extra/dropRepeats';
import isolate from '@cycle/isolate';
import {adapt} from '@cycle/run/lib/adapt';
export {pickCombine} from './pickCombine';
export {pickMerge} from './pickMerge';

export type MainFn<So, Si> = (sources: So) => Si;
export type Reducer<T> = (state: T | undefined) => T | undefined;
export type Getter<T, R> = (state: T | undefined) => R | undefined;
export type Setter<T, R> = (state: T | undefined, childState: R | undefined) => T | undefined;
export type Lens<T, R> = {
  get: Getter<T, R>;
  set: Setter<T, R>;
};
export type Scope<T, R> = string | number | Lens<T, R>;
export type Instances<Si> = {
  dict: Map<string, Si>,
  arr: Array<Si & {_key: string}>,
};

function defaultGetKey(statePiece: any) {
  return statePiece.key;
}

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

function makeGetter<T, R>(scope: Scope<T, R>): Getter<T, R> {
  if (typeof scope === 'string' || typeof scope === 'number') {
    return function lensGet(state) {
      if (typeof state === 'undefined') {
        return void 0;
      } else {
        return state[scope];
      }
    };
  } else {
    return scope.get;
  }
}

function makeSetter<T, R>(scope: Scope<T, R>): Setter<T, R> {
  if (typeof scope === 'string' || typeof scope === 'number') {
    return function lensSet(state: T, childState: R): T {
      if (Array.isArray(state)) {
        return updateArrayEntry(state, scope, childState) as any;
      } else if (typeof state === 'undefined') {
        return {[scope]: childState} as any as T;
      } else {
        return {...(state as any), [scope]: childState};
      }
    };
  } else {
    return scope.set;
  }
}

function updateArrayEntry<T>(array: Array<T>, scope: number | string, newVal: any): Array<T> {
  if (newVal === array[scope]) {
    return array;
  }
  const index = parseInt(scope as string);
  if (typeof newVal === 'undefined') {
    return array.filter((val, i) => i !== index);
  }
  return array.map((val, i) => i === index ? newVal : val);
}

export function isolateSource<T, R>(
                             source: StateSource<T>,
                             scope: Scope<T, R>): StateSource<R> {
  return source.select(scope);
}

export function isolateSink<T, R>(
                           innerReducer$: Stream<Reducer<R>>,
                           scope: Scope<T, R>): Stream<Reducer<T>> {
  const get = makeGetter(scope);
  const set = makeSetter(scope);

  return innerReducer$
    .map(innerReducer => function outerReducer(outer: T | undefined) {
      const prevInner = get(outer);
      const nextInner = innerReducer(prevInner);
      if (prevInner === nextInner) {
        return outer;
      } else {
        return set(outer, nextInner);
      }
    });
}

export class StateSource<T> {
  public state$: MemoryStream<T>;
  private _state$: MemoryStream<T>;
  private _name: string;

  constructor(stream: Stream<any>, name: string) {
    this._state$ = stream
      .filter(s => typeof s !== 'undefined')
      .compose(dropRepeats())
      .remember();
    this._name = name;
    this.state$ = adapt(this._state$);
    (this._state$ as MemoryStream<T> & DevToolEnabledSource)._isCycleSource = name;
  }

  public select<R>(scope: Scope<T, R>): StateSource<R> {
    const get = makeGetter(scope);
    return new StateSource<R>(this._state$.map(get), this._name);
  }

  public asCollection<Si>(itemComp: (so: any) => Si,
                          sources: any,
                          getKey: any = defaultGetKey): Stream<Instances<Si>> {
    const array$ = this._state$;
    const name = this._name;

    const collection$ = array$.fold((acc: Instances<Si>, nextStateArray: any) => {
      const dict = acc.dict;
      const nextInstArray = Array(nextStateArray.length) as Array<Si & {_key: string}>;

      const nextKeys = new Set<string>();
      // add
      for (let i = 0, n = nextStateArray.length; i < n; ++i) {
        const key = getKey(nextStateArray[i]);
        nextKeys.add(key);
        if (dict.has(key)) {
          nextInstArray[i] = dict.get(key) as any;
        } else {
          const scopes = {'*': '$' + key, [name]: instanceLens(getKey, key)};
          const sinks = isolate(itemComp, scopes)(sources);
          dict.set(key, sinks);
          nextInstArray[i] = sinks;
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
    }, {dict: new Map(), arr: []} as Instances<Si>);

    return collection$;
  }

  public isolateSource = isolateSource;
  public isolateSink = isolateSink;
}

/**
 * While we are waiting for keyof subtraction to land in TypeScript,
 * https://github.com/Microsoft/TypeScript/issues/12215,
 * we must use `any` as the type of sources or sinks in the mainOnionified.
 * This is because the correct type is *not*
 *
 * Main<So, Si>
 *
 * *neither*
 *
 * Main<Partial<So>, Partial<Si>>
 *
 * The former will signal to Cycle.run that a driver for 'onion' is needed,
 * while the latter will make valid channels like 'DOM' become optional.
 * The correct type should be
 *
 * Main<Omit<So, 'onion'>, Omit<Si, 'onion'>>
 */
export type Omit<T, K extends keyof T> = any;
// type Omit<T, K extends keyof T> = {
//     [P in keyof T - K]: T[P];
// };

export type OSo<T> = {onion: StateSource<T>};
export type OSi<T> = {onion: Stream<Reducer<T>>};

export type MainOnionified<T, So extends OSo<T>, Si extends OSi<T>> =
  MainFn<Omit<So, 'onion'>, Omit<Si, 'onion'>>;

export default function onionify<T, So extends OSo<T>, Si extends OSi<T>>(
                                main: MainFn<So, Si>,
                                name: string = 'onion'): MainOnionified<T, So, Si> {
  return function mainOnionified(sources: Omit<So, 'onion'>): Omit<Si, 'onion'> {
    const reducerMimic$ = xs.create<Reducer<T>>();
    const state$ = reducerMimic$
      .fold((state, reducer) => reducer(state), void 0 as (T | undefined))
      .drop(1);
    sources[name] = new StateSource<any>(state$, name);
    const sinks = main(sources as So);
    if (sinks[name]) {
      const stream$ = xs.fromObservable<Reducer<T>>(sinks[name]);
      reducerMimic$.imitate(stream$);
    }
    return sinks;
  };
}
