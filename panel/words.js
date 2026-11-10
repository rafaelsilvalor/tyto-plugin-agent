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
      'not-installed': ({ label, program }) =>
        `${label}'s ACP adapter, ${program}, is not on your PATH. Tyto installs no agent.`,
      'not-logged-in': ({ label }) =>
        `${label} is not signed in. It uses its own login: Tyto never sees or stores it.`,
      restricted: () =>
        'The folder open in Tyto is restricted, and Tyto starts no program in a restricted folder. Trust the folder to talk to an agent here.',
      'no-programs': () =>
        'This Tyto starts no programs for plugins; the agent panel works in the desktop app.',
      'no-tools': ({ label, status }) =>
        status === undefined
          ? `${label} started without Tyto's tools, so it cannot see the brief in front or act on it. The likely cause is an MCP server allowlist in your Claude Code settings (often set by your organisation, as allowedMcpServers) that does not list \`tyto\`. Ask your organisation's admin to allow the MCP server \`tyto\`; Tyto does not work around that policy.`
          : `${label} has Tyto's tools configured, but they did not connect (status: ${status}), so it cannot see the brief in front or act on it. Press New to start again; if it happens again, Claude Code's MCP log for \`tyto\` says why.`,
    },
    signInOnce: (login) => `then sign in once: ${login}`,
    openTerminal: (login) => `open a terminal in Tyto and run: ${login}`,
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
      'not-installed': ({ label, program }) =>
        `O adaptador ACP do ${label}, ${program}, não está no seu PATH. O Tyto não instala agentes.`,
      'not-logged-in': ({ label }) =>
        `O ${label} não está conectado. Ele usa o próprio login: o Tyto nunca o vê nem o guarda.`,
      restricted: () =>
        'A pasta aberta no Tyto é restrita, e o Tyto não inicia programas numa pasta restrita. Confie na pasta para conversar com um agente aqui.',
      'no-programs': () =>
        'Este Tyto não inicia programas para plugins; o painel do agente funciona no app de mesa.',
      'no-tools': ({ label, status }) =>
        status === undefined
          ? `O ${label} iniciou sem as ferramentas do Tyto, então não vê o brief da frente nem age nele. A causa provável é uma lista de servidores MCP permitidos nas configurações do Claude Code (muitas vezes definida pela sua organização, como allowedMcpServers) que não inclui \`tyto\`. Peça ao administrador da sua organização para permitir o servidor MCP \`tyto\`; o Tyto não contorna essa política.`
          : `O ${label} tem as ferramentas do Tyto configuradas, mas elas não conectaram (status: ${status}), então ele não vê o brief da frente nem age nele. Clique em Nova para recomeçar; se acontecer de novo, o log MCP do Claude Code para \`tyto\` diz por quê.`,
    },
    signInOnce: (login) => `depois entre uma vez: ${login}`,
    openTerminal: (login) => `abra um terminal no Tyto e rode: ${login}`,
  },
};
