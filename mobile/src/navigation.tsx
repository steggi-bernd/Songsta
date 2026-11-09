/**
 * Spotify's map: three tabs, each with its own stack of pages, so the player
 * and the tab bar stay in place (the tab bar slot holds both: BottomBar); the
 * lyrics and the queue open over everything.
 */
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { ComponentType } from "react";
import { BottomBar } from "./components/BottomBar";
import { AlbumScreen } from "./screens/AlbumScreen";
import { ArtistScreen } from "./screens/ArtistScreen";
import { CollectionScreen } from "./screens/CollectionScreen";
import { DevicesScreen } from "./screens/DevicesScreen";
import { EqualizerScreen } from "./screens/EqualizerScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { LyricsScreen } from "./screens/LyricsScreen";
import { QueueScreen } from "./screens/QueueScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { colors } from "./theme";
import { T } from "./shared";

const Root = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();
const Pages = createNativeStackNavigator();

const pageOptions = { headerShown: false, contentStyle: { backgroundColor: colors.base } };
/**
 * A page closed by pulling it down (components/PullDownToClose.tsx) lies see-through over the one
 * it was opened from: that one shows beneath while the page goes down, and stays where it is once
 * the page is gone, with no second animation.
 */
const pullDownPage = { presentation: "transparentModal", animation: "slide_from_right", contentStyle: { backgroundColor: "transparent" } } as const;

function tabStack(name: string, First: ComponentType) {
  return function TabStack() {
    return (
      <Pages.Navigator screenOptions={pageOptions}>
        <Pages.Screen name={name} component={First} />
        <Pages.Screen name="Album" component={AlbumScreen} options={pullDownPage} />
        <Pages.Screen name="Artist" component={ArtistScreen} options={pullDownPage} />
        <Pages.Screen name="Collection" component={CollectionScreen} options={pullDownPage} />
        <Pages.Screen name="Settings" component={SettingsScreen} />
        <Pages.Screen name="Equalizer" component={EqualizerScreen} />
      </Pages.Navigator>
    );
  };
}

const HomeTab = tabStack("Home", HomeScreen);
const SearchTab = tabStack("Search", SearchScreen);
const LibraryTab = tabStack("Library", LibraryScreen);

function Main() {
  return (
    <Tabs.Navigator
      tabBar={(props) => <BottomBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.base } }}
    >
      <Tabs.Screen name="HomeTab" component={HomeTab} />
      <Tabs.Screen name="SearchTab" component={SearchTab} />
      <Tabs.Screen name="LibraryTab" component={LibraryTab} />
    </Tabs.Navigator>
  );
}

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.base, card: colors.base, border: "transparent" } };

export function AppNavigation() {
  return (
    <NavigationContainer theme={theme}>
      <Root.Navigator screenOptions={pageOptions}>
        <Root.Screen name="Main" component={Main} />
        <Root.Screen name="Lyrics" component={LyricsScreen} options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
        <Root.Screen name="Devices" component={DevicesScreen} options={{ ...pullDownPage, animation: "slide_from_bottom" }} />
        <Root.Screen
          name="Queue"
          component={QueueScreen}
          options={{ presentation: "transparentModal", animation: "slide_from_bottom", contentStyle: { backgroundColor: "transparent" } }}
        />
      </Root.Navigator>
    </NavigationContainer>
  );
}
