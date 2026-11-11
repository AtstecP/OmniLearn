/*
 * The copyable AI prompts of the Import window, one per kind of material.
 * Each asks the AI for JSON in the bundle format that api/app/bundle.py parses and
 * web/lib/extractJson.ts extracts, so change the example shapes here, the parser and
 * sample_bundle.json together.
 */
export type PromptKind = "initial" | "roadmap" | "vocab" | "dictation" | "reading" | "test" | string;

export type PromptContext = {
  subjectName: string;       // the current subject's title
  level: string;             // its target level, or a neutral phrase
  targetLevel?: string | null;
  vocabTopic: string;        // "All words" or the open vocabulary topic
  readingTitles: string[];   // existing reading titles, so new texts are different
  lesson?: { title: string; content: string } | null; // the open lesson (test-question prompt)
};

export function buildPrompt(kind: PromptKind, ctx: PromptContext): string {
  const { subjectName, level } = ctx;
  let q={question:"Question text",options:["Option A","Option B","Option C","Option D"],answer:0,explanation:"Why the answer is correct and why the others are wrong."};
  let schema:any;
  let context="";
  if(kind==="initial"){
   schema={title:"Course title",description:"One-sentence summary of the course",level:"Target level",
    lessons:[{title:"Main step 1",level:"Level",content:"# Lesson in Markdown\n\nExplanations, examples, tables where useful.",questions:[q],
     lessons:[{title:"Sub-topic 1.1",content:"Markdown lesson",questions:[q]}]}],
    questions:[],vocabulary:[{term:"Key term",definition:"Clear meaning",part_of_speech:"noun (if it applies)",example:"Example in context",tags:["topic"]}],
    readings:[{title:"Reading title",level:"Level",content:"Passage in Markdown",questions:[q]}]};
   context="Create a complete course for the subject and goals described at the end of this prompt. It can be any subject. Build a roadmap of 4-8 main steps in learning order; put 2-6 sub-topics inside each main step's \"lessons\" list (sub-topics may have their own \"lessons\"). Every lesson needs substantial Markdown content with explanations and examples, plus 2-5 multiple-choice questions on that lesson. Add vocabulary cards for key terms and 1-3 reading passages with comprehension questions when they suit the subject; leave a list empty if it does not apply.";
  }else if(kind==="roadmap"){
   schema={lessons:[{title:"Main step",content:"# Markdown lesson",questions:[q],lessons:[{title:"Sub-topic",content:"Markdown lesson",questions:[q]}]}]};
   context="Create new lessons for "+subjectName+" at "+level+": 3-8 main steps in learning order, each with 2-6 sub-topics nested in its \"lessons\" list. Every lesson needs substantial Markdown content and 2-5 multiple-choice questions.";
  }else if(kind==="vocab"){
   schema={vocabulary:[{term:"Word or phrase",definition:"Clear meaning",part_of_speech:"Part of speech",example:"Natural example sentence",tags:["topic"]}]};
   context="Prepare useful vocabulary for "+subjectName+" at "+level+". Topic: "+(ctx.vocabTopic==="All words"?"choose a useful topic":ctx.vocabTopic)+".";
  }else if(kind==="dictation"){
   schema={phrases:[{answer:"One complete natural phrase or sentence in the language being learned (spoken aloud and typed by the learner)",translation:"Its translation into the learner's own language (shown on screen)",tags:["topic"]}]};
   context="Prepare 30-60 phrases for DICTATION practice for "+subjectName+" at "+level+". Each item's \"answer\" is ONE complete natural phrase or sentence of 3-12 words with correct spelling and punctuation, so use everyday spoken language and write numbers as words. Each item's \"translation\" is its translation. Put a short topic in \"tags\". Use only the keys answer, translation and tags.";
  }else if(kind==="reading"){
   schema={readings:[{title:"Passage title",level:ctx.targetLevel||"Level",content:"Passage in Markdown",questions:[q]}]};
   context="Create engaging reading passages (1-3, each 150-400 words) about the subject \""+subjectName+"\" at "+level+", each with 3-5 comprehension questions. Stay on this subject and use the topic or source text given at the end of this prompt."+(ctx.readingTitles.length?"\nTexts that already exist (write different ones, do not repeat these titles): "+ctx.readingTitles.join("; ")+".":"");
  }else{
   let lesson=ctx.lesson;
   schema={questions:[{...q,tags:["topic"]}]};
   context="Create 5-10 multiple-choice questions for "+subjectName+(lesson?", lesson \""+lesson.title+"\"":"")+"."+(lesson?"\nLESSON MATERIAL (use only this as the source; do not test facts that are not in it):\n"+lesson.content:"");
  }
  const fence="`".repeat(3);
  let prompt="Act as an expert educator and learning-material designer. "+context
   +"\n\nOUTPUT FORMAT (important): reply with the finished JSON ready to copy, in ONE code block that starts with "+fence+"json and ends with "+fence+", and put nothing else in your reply: no introduction, no explanation, no follow-up questions. If you can create files, also attach the same JSON as a downloadable file named learnify.json."
   +"\n\nThe JSON must match this example:\n"+JSON.stringify(schema,null,2)
   +"\n\nRules:\n- Valid JSON only: double-quoted keys and strings, no comments, no trailing commas.\n- Do not add any \"id\" fields; structure comes from nesting and order.\n- \"answer\" is the zero-based index of the correct option (0 = first option). Each question has 2-6 options and exactly one correct answer.\n- Write lesson and reading content in Markdown. Inside JSON strings write line breaks as \\n and escape double quotes as \\\". Do not use triple backticks inside the content (use indented or inline code instead) so the code block stays intact.\n- Give a clear explanation for every answer.\n- Keep it complete: if the course is too long for one reply, return fewer lessons per reply instead of cutting the JSON off.";
  if(kind==="initial")prompt+="\n\nYOUR SUBJECT AND LEARNING GOALS:\n[Describe what you want to learn, your current level, goals, and topics to include.]";
  if(kind==="reading")prompt+="\n\nTOPIC, SOURCE TEXT, OR REQUEST FOR THE READING:\n[Write the topic or situation you want, paste a text to turn into a reading, or delete this line to let the AI choose a topic within the subject.]";
  if(kind==="dictation")prompt+="\n\nTOPIC, SITUATION, OR SOURCE TEXT FOR THE PHRASES:\n[Write a topic (for example ordering food), paste a text to turn into sentences, or delete this line to let the AI choose.]";
  if(kind==="vocab")prompt+="\n\nUSER TOPIC, SOURCE MATERIAL, OR REQUIRED WORDS:\n[Write a topic, paste source content, or list the exact vocabulary you want included here.]";
  return prompt;
}
