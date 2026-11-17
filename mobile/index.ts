import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { createElement, useEffect, useState, type ComponentType } from 'react';
import { I18nManager } from 'react-native';

import { languageOf, setLanguage, type LanguageChoice } from '../src/lib/i18n';

/** The language before any other code loads: some texts are read as modules load. */
function chosenLanguage(): LanguageChoice {
  try {
    const file = new File(Paths.document, 'settings.json');
    if (file.exists) return JSON.parse(file.textSync()).language ?? 'auto';
  } catch {
    /* as the system has it */
  }
  return 'auto';
}
const language = chosenLanguage();
setLanguage(language === 'auto' ? languageOf(I18nManager.getConstants().localeIdentifier) : language);

const { restoreSettings } = require('./src/stores/settings') as typeof import('./src/stores/settings');

/** Settings first: the accent colour goes into every screen's styles as those are made. */
function Boot() {
  const [App, setApp] = useState<ComponentType | null>(null);
  useEffect(() => {
    void restoreSettings().then(() => {
      // From here on, the app's requests pass the switches in Settings → Network & privacy.
      (require('./src/netGate') as typeof import('./src/netGate')).installNetGate();
      setApp(() => require('./App').default);
    });
  }, []);
  return App ? createElement(App) : null;
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => Boot);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Boot);
