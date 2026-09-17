import abler from '../../../../packages/abler-mcp/package.json';
import infomentor from '../../../../packages/infomentor-mcp/package.json';
import kronan from '../../../../packages/kronan-mcp/package.json';
import dominos from '../../../../packages/dominos-mcp/package.json';

export type Locale = 'en' | 'is';
export const repository = 'https://github.com/olafurns7/family-mcp';

export const servers = [
  { id: 'abler', name: 'Abler', manifest: abler },
  { id: 'infomentor', name: 'InfoMentor', manifest: infomentor },
  { id: 'kronan', name: 'Krónan', manifest: kronan },
  { id: 'dominos', name: 'Domino’s', manifest: dominos },
].map(({ id, name, manifest }) => ({
  id,
  name,
  version: manifest.version,
  preview: id === 'dominos',
  command: `curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/${manifest.name}@${manifest.version}/packages/${manifest.name}/install.sh | sh`,
  documentation: `${repository}/tree/${manifest.name}@${manifest.version}/packages/${manifest.name}#readme`,
  release: `${repository}/releases/tag/${manifest.name}@${manifest.version}`,
}));

export const content = {
  en: {
    title: 'Family MCP: Icelandic apps for your AI assistant',
    description:
      'Unofficial MCP servers for Abler, InfoMentor, Krónan and Domino’s Iceland. Install them on your computer and connect them to an AI app that supports MCP.',
    skip: 'Skip to the servers',
    language: 'Language',
    source: 'Source on GitHub',
    headline: ['Connect Icelandic apps', 'to your AI assistant.'],
    introduction:
      'Unofficial MCP servers for Abler, InfoMentor, Krónan and Domino’s Iceland. Install them on your computer and connect them to an AI app that supports MCP.',
    servers: 'MCP servers',
    install: 'Install in your terminal',
    copy: 'Copy command',
    copied: 'Copied!',
    copyError: 'Couldn’t copy the command. It’s selected for you to copy manually.',
    copyConfirmation: 'Install command copied for',
    setup: 'Setup guide',
    preview: 'Preview',
    release: 'Release',
    nextHeading: 'Get started',
    nextText:
      'Run the command for the server you want, then follow its setup guide to sign in and add it to your MCP client.',
    privacy:
      'Sign-in credentials are stored on your machine. Account data returned by the tools is shared with your chosen MCP client.',
    footer: 'Made by',
    affiliation: 'Not affiliated with or endorsed by the services above.',
    tools: {
      abler: {
        description:
          'Check your family’s Abler groups, practice and match schedules, and attendance.',
        login: 'Browser sign-in',
      },
      infomentor: {
        description:
          'Read timetables, messages and school updates from your Icelandic InfoMentor account.',
        login: 'Your school account',
      },
      kronan: {
        description: 'Search Krónan products and recipes, and look up your previous purchases.',
        login: 'Personal API token',
      },
      dominos: {
        description:
          'Browse the menu, check prices and track an order. Payments with a saved card are in preview.',
        login: 'SMS sign-in',
        limitation:
          'Card charging is untested. Bank verification (3-D Secure) isn’t supported yet; payment requires explicit confirmation.',
      },
    },
  },
  is: {
    title: 'Family MCP: tengdu íslensk öpp við gervigreind',
    description:
      'Óopinberir MCP-þjónar fyrir Abler, InfoMentor, Krónuna og Domino’s. Settu þá upp á tölvunni þinni og tengdu við gervigreindarforrit sem styður MCP.',
    skip: 'Fara beint í uppsetningu',
    language: 'Tungumál',
    source: 'Kóðinn á GitHub',
    headline: ['Tengdu íslensk öpp', 'við gervigreind.'],
    introduction:
      'Óopinberir MCP-þjónar fyrir Abler, InfoMentor, Krónuna og Domino’s. Settu þá upp á tölvunni þinni og tengdu við gervigreindarforrit sem styður MCP.',
    servers: 'MCP-þjónar',
    install: 'Uppsetning',
    copy: 'Afrita skipun',
    copied: 'Afritað',
    copyError: 'Ekki tókst að afrita. Afritaðu valda textann handvirkt.',
    copyConfirmation: 'Skipun afrituð:',
    setup: 'Leiðbeiningar',
    preview: 'Prufuútgáfa',
    release: 'Útgáfa',
    nextHeading: 'Svona byrjarðu',
    nextText:
      'Afritaðu skipunina og keyrðu hana í skipanalínu. Fylgdu svo leiðbeiningunum til að skrá þig inn og tengja þjóninn við gervigreindarforritið þitt.',
    privacy:
      'Innskráningarupplýsingarnar eru geymdar á tölvunni þinni. Gögnin sem þú sækir með þjónunum fara til gervigreindarforritsins sem þú notar.',
    footer: 'Höfundur:',
    affiliation:
      'Fyrirtækin hér að ofan standa ekki að verkefninu og hafa ekki lagt nafn sitt við það.',
    tools: {
      abler: {
        description: 'Skoðaðu hópa fjölskyldunnar í Abler, æfingar, leiki og mætingar.',
        login: 'Innskráning í vafra',
      },
      infomentor: {
        description: 'Sæktu stundatöflur, skilaboð og tilkynningar úr InfoMentor.',
        login: 'InfoMentor-aðgangur',
      },
      kronan: {
        description: 'Leitaðu að vörum og uppskriftum hjá Krónunni og skoðaðu fyrri innkaup.',
        login: 'API-lykill',
      },
      dominos: {
        description:
          'Skoðaðu matseðilinn, athugaðu verðið og fylgstu með pöntuninni. Greiðslur með vistuðu korti eru á tilraunastigi.',
        login: 'Innskráning með SMS',
        limitation:
          'Kortagreiðslur hafa ekki verið prófaðar og bankastaðfesting með 3-D Secure er ekki studd enn. Engin greiðsla fer fram án skýrs samþykkis þíns.',
      },
    },
  },
} as const;
