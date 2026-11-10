# Mesa de PDF

Junte, separe e organize páginas de PDF e transforme fotos em PDF. **Tudo no navegador:** seus arquivos não são enviados nem guardados em lugar nenhum.

Parte do [VF Tools](https://vitorfariasvf.github.io/VF-Tools/). Segue o [padrão de design](https://github.com/VitorFariasVF/VF-Tools/blob/Main/DESIGN.md) do site.

## O que faz
- **Juntar:** solte vários PDFs e fotos; as páginas viram miniaturas numa mesa única.
- **Separar:** exporte só as páginas selecionadas ou um intervalo como `1-3, 5, 8-10`.
- **Organizar:** arraste as páginas (mouse ou toque, pela alça) ou use os botões "Para trás", "Para a frente" e "Mover" para uma posição. Gire, exclua, duplique e insira páginas em branco. Há **desfazer/refazer** e **ampliar** uma página.
- **Fotos em PDF:** JPG, PNG e WebP, uma foto por página. Tamanho (A4, Carta ou ajustar à foto), margem e qualidade.
- **Comprimir:** Leve, Média ou Forte. As páginas dos PDFs viram imagens JPEG menores (o texto deixa de ser selecionável).
- **Marca d’água e carimbo:** texto (Confidencial, Rascunho, Aprovado…) ou imagem, com cor, tamanho, opacidade, ângulo, posição e contorno estilo carimbo, em todas as páginas.
- **Numerar páginas:** “Página X de Y”, “X / Y”, “X” ou “- X -”, seis posições, número inicial e opção de não numerar a capa.
- **Assinar:** desenhe, digite ou envie uma imagem da assinatura e posicione na página (arrastando ou pelos controles). Vale uma página ou todas. É uma imagem colada no PDF, não uma assinatura digital certificada. Ela fica só na memória do navegador.
- **Cortar:** remova margens das páginas selecionadas (ou de todas), com prévia. **Atenção:** o corte só esconde as bordas; o conteúdo cortado continua dentro do arquivo. Não use para ocultar dados sensíveis.
- **Preferências** (tamanho, margem e qualidade) ficam no `localStorage`. Os arquivos nunca.

## Privacidade
Os arquivos e as senhas nunca são enviados nem guardados. Só as preferências (tamanho, margem, qualidade, compressão, marca d’água e numeração) ficam no `localStorage`, e “Limpar meus dados” apaga tudo isso. Ao abrir a página, o navegador baixa o CSS e o JavaScript compartilhados do VF Tools (vitorfariasvf.github.io); depois de carregada, a ferramenta funciona sem internet.

## PDFs com senha
Um PDF protegido entra na mesa como um card com cadeado (“PDF não disponível”). Toque nele, digite a senha no modal e as páginas aparecem no mesmo lugar. Enquanto houver cadeado na mesa o download fica bloqueado (desbloqueie ou remova). A senha só é usada no navegador e não é guardada. Páginas de PDFs desbloqueados são exportadas como imagem, então o texto deixa de ser selecionável.

## Limites
50 MB por arquivo · 150 MB no total · 200 páginas por PDF · 30 fotos no celular (60 no computador). Fotos são reduzidas (lado maior de 2000 px) para não travar o aparelho; "Original" usa até 4096 px (3000 px no celular).
Fotos HEIC do iPhone não são aceitas pelo navegador: converta para JPG.

## Acessibilidade
Arrastar nunca é o único caminho: há botões de mover e o campo "Posição". Teclado: setas movem o foco, **Espaço** seleciona, **Enter** amplia, **Alt + seta** move a página, **Delete** exclui, **Ctrl+Z** desfaz. Cada miniatura tem nome acessível ("Página 3 de 20, arquivo.pdf, selecionada") e as ações são anunciadas por `aria-live`.

## Estrutura
| Arquivo | Para quê |
|---|---|
| `index.html` | Página (modelo do VF Tools) |
| `app.js` / `app.css` | Lógica e estilos da ferramenta |
| `extras.js` | Marca d’água, numeração, assinatura e corte (ligados ao `app.js` por ganchos) |
| `tool.js` | Helper do VF Tools (armazenamento por ferramenta, tema, toast) |
| `vendor/` | [pdf-lib](https://pdf-lib.js.org) (MIT) para gerar PDFs e [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) para as miniaturas. Guardadas aqui para funcionar sem CDN e offline depois do primeiro carregamento |

O visual vem do site (`tokens.css`, `components.css`, `doggy.css`, `dog.js`, `help.js`), carregado de `vitorfariasvf.github.io/VF-Tools/`.

## Rodar localmente
```bash
python3 -m http.server 8765
# abra http://localhost:8765
```
É um site estático, sem build.

## Verificar a identidade
```bash
node /caminho/para/VF-Tools/scripts/check-identity.js index.html
```
