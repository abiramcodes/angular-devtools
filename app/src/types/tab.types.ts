export type Tab =
  | 'dashboard'
  | 'components'
  | 'pipes'
  | 'routes'
  | 'signals'
  | 'injectors'
  | 'store'
  | 'forms'
  | 'network'
  | 'analog';

export type Tabs = {
  id: Tab;
  label: string;
};
