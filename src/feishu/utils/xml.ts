// 飞书 Doc XML → 可读文本转换

const BLOCK_TAGS = [
    'page', 'paragraph', 'heading1', 'heading2', 'heading3',
    'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9',
    'bullet_list', 'ordered_list', 'list_item', 'code_block',
    'callout', 'quote', 'divider', 'table', 'table_row', 'table_cell',
    'image_block', 'file_block', 'grid', 'grid_column',
    'todo_list', 'synced_block'
];

const CLOSE_TAG_RES: RegExp[] = BLOCK_TAGS.map((tag) => new RegExp(`</${tag}>`, 'g'));

const OPEN_HEADING_RES: RegExp[] = [];
for (let i = 1; i <= 9; i++) {
    OPEN_HEADING_RES.push(new RegExp(`<heading${i}[^>]*>`, 'g'));
}

export function xmlToReadable(xml: string): string {
    let text = xml;

    for (let i = 0; i < BLOCK_TAGS.length; i++) {
        text = text.replace(CLOSE_TAG_RES[i]!, '\n');
    }

    for (let i = 0; i < 9; i++) {
        text = text.replace(OPEN_HEADING_RES[i]!, `${'#'.repeat(i + 1)} `);
    }

    text = text.replace(/<list_item[^>]*>/g, '\n- ');
    text = text.replace(/<todo_list[^>]*>/g, '\n- [ ] ');
    text = text.replace(/<ordered_list[^>]*>/g, '\n1. ');
    text = text.replace(/<divider[^>]*>/g, '\n---\n');
    text = text.replace(/<code_block[^>]*>/g, '\n```\n');
    text = text.replace(/<\/code_block>/g, '\n```\n');
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
}
