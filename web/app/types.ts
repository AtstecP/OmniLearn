// Shapes of the API data the app works with.
export type Subject={id:string;title:string;description?:string;target_level?:string};
export type Node={id:string;subject_id:string;parent_node_id?:string|null;title:string;level?:string;order_index:number;content_markdown?:string;test_ids:string[]};
export type Test={id:string;subject_id:string;node_id?:string|null;prompt:string;options:string[];correct_index:number;explanation:string;tags:string[]};
export type Card={id:string;subject_id:string;term:string;part_of_speech?:string;definition:string;example_sentence?:string;image_url?:string;tags:string[];progress?:any;is_due:boolean};
export type Phrase={id:string;answer:string;translation:string;audio_url?:string|null;tags:string[]};
export type Reading={id:string;title:string;level?:string;passage_markdown?:string;audio_url?:string;questions?:any[];question_count?:number};
export type User={id:string;email:string;full_name:string};
export type Page="dashboard"|"roadmap"|"vocabulary"|"vocabulary-practice"|"dictation"|"readings"|"tests"|"mistakes"|"favorites"|"lesson"|"lesson-test"|"settings";
