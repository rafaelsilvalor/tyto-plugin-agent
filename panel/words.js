// The panel's words, in the two languages Tyto speaks (`en`, `pt-BR`). The page follows the
// window's language, which Tyto sends as a `language` event (Tyto 0.18, TYTO-660); an older Tyto
// sends none, and the page falls back to the browser's language, which is the operating
// system's, not Tyto's setting.
//
// The plugin's process speaks English and sends, with every message the person reads, a code and
// the names it was built from; these tables say the same in the page's language. A code this
// table does not know shows the process's English text.

/* exported WORDS */
const WORDS = {
  en: {
    agent: 'Agent',
    newConversation: 'New',
    newTitle: 'End this conversation and start a new one',
    placeholder: 'Ask the agent… (Enter sends, Shift+Enter adds a line)',
    send: 'Send',
    stop: 'Stop',
    stopTitle: 'Stop the running turn',
    contextTitle: 'What the agent sees in Tyto',
    noBrief: 'no brief in front',
    reach: {
      missing: 'the agent has no Tyto tools',
      off: 'agents are off in Tyto (agentsListen)',
      unavailable: 'no Tyto window',
    },
    thinking: 'thinking…',
    using: (tool) => `using ${tool}…`,
    waiting: 'waiting for your answer…',
    stopping: 'stopping…',
    tools: {
      list_templates: 'list templates',
      describe_template: 'describe a template',
      check_brief: 'check the brief',
      render_preview: 'render a preview',
      brief_in_front: 'read the brief in front',
      selection: 'read the selection',
      open_file: 'open a file',
      show_format: 'show a format',
      propose_edit: 'propose an edit',
      proposal_status: 'check a proposal',
    },
    toolStatus: {
      pending: 'pending',
      in_progress: 'running',
      completed: 'completed',
      failed: 'failed',
    },
    asks: (title) => `The agent asks to use ${title}.`,
    answered: (name) => `Answered: ${name}`,
    cancelled: 'cancelled',
    stopped: (reason) => `Stopped: ${reason}`,
    reasons: {
      cancelled: 'you stopped it',
      max_tokens: 'the reply got too long',
      refusal: 'the agent refused',
    },
    earlier: 'Earlier in this folder ↑',
    unreachable: (message) => `The panel could not reach the plugin: ${message}`,
    notices: {
      'agents-off': () =>
        'Tyto does not let agents connect (setting agentsListen), so the agent cannot see the brief in front or propose edits. Turn it on and start a new conversation.',
      ended: ({ exit }) => `The agent ended (exit ${exit}). Your next message starts it again.`,
      'not-started': () => 'The agent did not start.',
      'turn-failed': ({ message }) => `The turn failed: ${message}`,
    },
    refusals: {
      busy: 'A turn is running; wait for it or stop it.',
      empty: 'The message is empty.',
    },
    problems: {
      'script-missing': ({ program }) =>
        `The agent plugin's own program, ${program}, is missing from its folder. Reinstall the plugin.`,
      'old-tyto': ({ label }) =>
        `The agent panel needs Tyto 0.18 or later, which gives a plugin's program a folder to download ${label}'s adapter into. Update Tyto.`,
      'no-claude': ({ label, found }) =>
        found === 'shim'
          ? `${label} Code was found only as an npm shim (claude.cmd), which the adapter cannot start. Install ${label} Code natively, so that claude.exe is on your PATH, then press New.`
          : `${label} Code is not installed: the panel talks to your own \`claude\`, and it is not on your PATH. Install ${label} Code, then press New.`,
      'not-downloaded': ({ label, version, size, source }) =>
        `${label}'s adapter is not downloaded yet. **Download** fetches @agentclientprotocol/claude-agent-acp ${version} from ${source}, about ${size} MB on disk, into Tyto's folder for this plugin, and checks every file against the hash this plugin pins. It includes Anthropic's Claude Agent SDK, under Anthropic's own terms.`,
      downloading: ({ label, done, total }) =>
        total === '0'
          ? `Downloading ${label}'s adapter…`
          : `Downloading ${label}'s adapter: ${done} of ${total} packages.`,
      'download-failed': ({ label, code, reason }) =>
        `${label}'s adapter did not download, and nothing was installed (${code}): ${reason}. Press New to try again.`,
      'not-logged-in': ({ label, canLogIn }) =>
        canLogIn
          ? `${label} is not signed in. **Log in** opens a Tyto terminal where ${label}'s own sign-in runs and your browser opens on its page; Tyto never sees or stores the login.`
          : `${label} is not signed in, and its adapter offers no sign-in Tyto can open in a terminal. Sign ${label} in yourself, then press New. Tyto never sees or stores the login.`,
      restricted: () =>
        'The folder open in Tyto is restricted, and Tyto starts no program in a restricted folder. Trust the folder to talk to an agent here.',
      'no-programs': () =>
        'This Tyto starts no programs for plugins; the agent panel works in the desktop app.',
      'no-tools': ({ label, status }) =>
        status === undefined
          ? `${label} started without Tyto's tools, so it cannot see the brief in front or act on it. The likely cause is an MCP server allowlist in your Claude Code settings (often set by your organisation, as allowedMcpServers) that does not list \`tyto\`. Ask your organisation's admin to allow the MCP server \`tyto\`; Tyto does not work around that policy.`
          : `${label} has Tyto's tools configured, but they did not connect (status: ${status}), so it cannot see the brief in front or act on it. Press New to start again; if it happens again, Claude Code's MCP log for \`tyto\` says why.`,
    },
    download: 'Download',
    downloaded: (label) => `${label}'s adapter is downloaded.`,
    logIn: (label) => `Log in to ${label}`,
    tryAgain: 'Try again',
    loginOpened:
      'The sign-in runs in the Terminal tab below. Finish it in your browser, then come back here: the panel tries again by itself.',
    signedIn: (label) => `${label} is signed in.`,
    loginRefusals: {
      'no-method': 'The agent offers no sign-in Tyto can open. Press New to ask it again.',
      'already-open':
        'A sign-in terminal is already open. Finish it there, or close that tab and press Log in again.',
      restricted: 'The folder open in Tyto is restricted, so Tyto opens no terminal here.',
      'no-terminal': 'This Tyto has no terminal; sign in from the desktop app.',
      failed: (reason) => `The sign-in terminal did not open: ${reason}`,
    },
  },
  'pt-BR': {
    agent: 'Agente',
    newConversation: 'Nova',
    newTitle: 'Encerrar esta conversa e começar outra',
    placeholder: 'Pergunte ao agente… (Enter envia, Shift+Enter quebra a linha)',
    send: 'Enviar',
    stop: 'Parar',
    stopTitle: 'Parar a resposta em andamento',
    contextTitle: 'O que o agente vê no Tyto',
    noBrief: 'nenhum brief na frente',
    reach: {
      missing: 'o agente está sem as ferramentas do Tyto',
      off: 'agentes desligados no Tyto (agentsListen)',
      unavailable: 'sem janela do Tyto',
    },
    thinking: 'pensando…',
    using: (tool) => `usando ${tool}…`,
    waiting: 'esperando a sua resposta…',
    stopping: 'parando…',
    tools: {
      list_templates: 'listar templates',
      describe_template: 'descrever um template',
      check_brief: 'verificar o brief',
      render_preview: 'renderizar uma prévia',
      brief_in_front: 'ler o brief da frente',
      selection: 'ler a seleção',
      open_file: 'abrir um arquivo',
      show_format: 'mostrar um formato',
      propose_edit: 'propor uma edição',
      proposal_status: 'consultar uma proposta',
    },
    toolStatus: {
      pending: 'na fila',
      in_progress: 'rodando',
      completed: 'concluída',
      failed: 'falhou',
    },
    asks: (title) => `O agente pede para usar ${title}.`,
    answered: (name) => `Respondido: ${name}`,
    cancelled: 'cancelado',
    stopped: (reason) => `Parou: ${reason}`,
    reasons: {
      cancelled: 'você parou',
      max_tokens: 'a resposta ficou longa demais',
      refusal: 'o agente recusou',
    },
    earlier: 'Antes, nesta pasta ↑',
    unreachable: (message) => `O painel não alcançou o plugin: ${message}`,
    notices: {
      'agents-off': () =>
        'O Tyto não deixa agentes se conectarem (configuração agentsListen), então o agente não vê o brief da frente nem propõe edições. Ligue-a e comece uma conversa nova.',
      ended: ({ exit }) =>
        `O agente encerrou (saída ${exit}). A sua próxima mensagem o inicia de novo.`,
      'not-started': () => 'O agente não iniciou.',
      'turn-failed': ({ message }) => `A resposta falhou: ${message}`,
    },
    refusals: {
      busy: 'Há uma resposta em andamento; espere ou pare.',
      empty: 'A mensagem está vazia.',
    },
    problems: {
      'script-missing': ({ program }) =>
        `O programa do próprio plugin do agente, ${program}, sumiu da pasta dele. Reinstale o plugin.`,
      'old-tyto': ({ label }) =>
        `O painel do agente precisa do Tyto 0.18 ou mais novo, que dá ao programa de um plugin uma pasta para baixar o adaptador do ${label}. Atualize o Tyto.`,
      'no-claude': ({ label, found }) =>
        found === 'shim'
          ? `O ${label} Code só foi encontrado como atalho do npm (claude.cmd), que o adaptador não consegue abrir. Instale o ${label} Code nativo, para que o claude.exe esteja no seu PATH, e clique em Nova.`
          : `O ${label} Code não está instalado: o painel conversa com o seu próprio \`claude\`, e ele não está no seu PATH. Instale o ${label} Code e clique em Nova.`,
      'not-downloaded': ({ label, version, size, source }) =>
        `O adaptador do ${label} ainda não foi baixado. **Baixar** busca o @agentclientprotocol/claude-agent-acp ${version} em ${source}, cerca de ${size} MB em disco, para a pasta do Tyto deste plugin, e confere cada arquivo com o hash que o plugin fixa. Ele inclui o Claude Agent SDK da Anthropic, sob os termos da própria Anthropic.`,
      downloading: ({ label, done, total }) =>
        total === '0'
          ? `Baixando o adaptador do ${label}…`
          : `Baixando o adaptador do ${label}: ${done} de ${total} pacotes.`,
      'download-failed': ({ label, code, reason }) =>
        `O adaptador do ${label} não foi baixado, e nada foi instalado (${code}): ${reason}. Clique em Nova para tentar de novo.`,
      'not-logged-in': ({ label, canLogIn }) =>
        canLogIn
          ? `O ${label} não está conectado. **Entrar** abre um terminal do Tyto onde roda o login do próprio ${label}, e o seu navegador abre na página dele; o Tyto nunca vê nem guarda o login.`
          : `O ${label} não está conectado, e o adaptador dele não oferece um login que o Tyto possa abrir num terminal. Entre no ${label} por conta própria e clique em Nova. O Tyto nunca vê nem guarda o login.`,
      restricted: () =>
        'A pasta aberta no Tyto é restrita, e o Tyto não inicia programas numa pasta restrita. Confie na pasta para conversar com um agente aqui.',
      'no-programs': () =>
        'Este Tyto não inicia programas para plugins; o painel do agente funciona no app de mesa.',
      'no-tools': ({ label, status }) =>
        status === undefined
          ? `O ${label} iniciou sem as ferramentas do Tyto, então não vê o brief da frente nem age nele. A causa provável é uma lista de servidores MCP permitidos nas configurações do Claude Code (muitas vezes definida pela sua organização, como allowedMcpServers) que não inclui \`tyto\`. Peça ao administrador da sua organização para permitir o servidor MCP \`tyto\`; o Tyto não contorna essa política.`
          : `O ${label} tem as ferramentas do Tyto configuradas, mas elas não conectaram (status: ${status}), então ele não vê o brief da frente nem age nele. Clique em Nova para recomeçar; se acontecer de novo, o log MCP do Claude Code para \`tyto\` diz por quê.`,
    },
    download: 'Baixar',
    downloaded: (label) => `O adaptador do ${label} foi baixado.`,
    logIn: (label) => `Entrar no ${label}`,
    tryAgain: 'Tentar de novo',
    loginOpened:
      'O login roda na aba Terminal, abaixo. Termine no navegador e volte aqui: o painel tenta de novo sozinho.',
    signedIn: (label) => `O ${label} está conectado.`,
    loginRefusals: {
      'no-method':
        'O agente não oferece um login que o Tyto possa abrir. Clique em Nova para perguntar de novo.',
      'already-open':
        'Já há um terminal de login aberto. Termine nele, ou feche aquela aba e clique em Entrar de novo.',
      restricted: 'A pasta aberta no Tyto é restrita, então o Tyto não abre terminal aqui.',
      'no-terminal': 'Este Tyto não tem terminal; entre pelo app de mesa.',
      failed: (reason) => `O terminal de login não abriu: ${reason}`,
    },
  },
};
